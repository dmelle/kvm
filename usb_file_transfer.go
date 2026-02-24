package kvm

import (
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/jetkvm/kvm/internal/logging"
	"github.com/jetkvm/kvm/internal/sync"
)

const transferImagePath = "/userdata/jetkvm/transfer.img"
const transferMountPath = "/userdata/jetkvm/transfer_mnt"

type FileTransferState string

const (
	FileTransferNoDrive         FileTransferState = "no_drive"
	FileTransferLocallyMounted  FileTransferState = "locally_mounted"
	FileTransferConnectedTarget FileTransferState = "connected_to_target"
)

var (
	fileTransferState      FileTransferState = FileTransferNoDrive
	fileTransferStateMutex sync.RWMutex
	fileTransferLogger     = logging.GetSubsystemLogger("file_transfer")
)

type FileTransferStateResponse struct {
	State FileTransferState   `json:"state"`
	Files []FileTransferEntry `json:"files,omitempty"`
	Size  int64               `json:"size,omitempty"`
	Used  int64               `json:"used,omitempty"`
}

type FileTransferEntry struct {
	Name string `json:"name"`
	Size int64  `json:"size"`
}

func getFileTransferLun1Path() (string, error) {
	lun1Path, err := gadget.GetPath("mass_storage_lun1")
	if err != nil {
		return "", fmt.Errorf("failed to get lun.1 path: %w", err)
	}
	return lun1Path, nil
}

func setFileTransferImage(imagePath string) error {
	lun1Path, err := getFileTransferLun1Path()
	if err != nil {
		return err
	}
	if err := writeFile(path.Join(lun1Path, "file"), imagePath); err != nil {
		return fmt.Errorf("failed to set lun.1 file: %w", err)
	}
	return nil
}

func loopMountTransferImage() error {
	if err := os.MkdirAll(transferMountPath, 0755); err != nil {
		return fmt.Errorf("failed to create mount point: %w", err)
	}

	// BusyBox mount doesn't support -o loop, so use losetup manually
	out, err := exec.Command("losetup", "-f", transferImagePath).CombinedOutput()
	if err != nil {
		return fmt.Errorf("failed to setup loop device: %w, output: %s", err, string(out))
	}

	// Find which loop device was assigned
	out, err = exec.Command("losetup", "-a").CombinedOutput()
	if err != nil {
		return fmt.Errorf("failed to list loop devices: %w, output: %s", err, string(out))
	}

	var loopDev string
	for _, line := range strings.Split(string(out), "\n") {
		if strings.Contains(line, transferImagePath) {
			loopDev = strings.SplitN(line, ":", 2)[0]
			break
		}
	}
	if loopDev == "" {
		return fmt.Errorf("failed to find loop device for %s", transferImagePath)
	}

	out, err = exec.Command("mount", loopDev, transferMountPath).CombinedOutput()
	if err != nil {
		// Clean up loop device on mount failure
		_ = exec.Command("losetup", "-d", loopDev).Run()
		return fmt.Errorf("failed to mount loop device: %w, output: %s", err, string(out))
	}
	return nil
}

func unmountTransferImage() error {
	out, err := exec.Command("umount", transferMountPath).CombinedOutput()
	if err != nil {
		return fmt.Errorf("failed to unmount: %w, output: %s", err, string(out))
	}

	// Detach any loop devices associated with our image
	loOut, err := exec.Command("losetup", "-a").CombinedOutput()
	if err == nil {
		for _, line := range strings.Split(string(loOut), "\n") {
			if strings.Contains(line, transferImagePath) {
				loopDev := strings.SplitN(line, ":", 2)[0]
				_ = exec.Command("losetup", "-d", loopDev).Run()
			}
		}
	}
	return nil
}

func isTransferImageMounted() bool {
	out, err := exec.Command("mountpoint", "-q", transferMountPath).CombinedOutput()
	if err != nil {
		_ = out
		return false
	}
	return true
}

func rpcFileTransferCreateDrive(sizeMB float64) (*FileTransferStateResponse, error) {
	fileTransferStateMutex.Lock()
	defer fileTransferStateMutex.Unlock()

	if fileTransferState != FileTransferNoDrive {
		return nil, fmt.Errorf("drive already exists (state: %s)", fileTransferState)
	}

	sizeInt := int(sizeMB)
	if sizeInt < 1 || sizeInt > 4096 {
		return nil, fmt.Errorf("sizeMB must be between 1 and 4096")
	}

	fileTransferLogger.Info().Int("sizeMB", sizeInt).Msg("creating file transfer drive")

	// Create the image file
	out, err := exec.Command("dd", "if=/dev/zero", "of="+transferImagePath, "bs=1M", fmt.Sprintf("count=%d", sizeInt)).CombinedOutput()
	if err != nil {
		return nil, fmt.Errorf("failed to create image: %w, output: %s", err, string(out))
	}

	// Format as FAT32
	out, err = exec.Command("mkfs.vfat", "-F", "32", "-n", "JETKVM", transferImagePath).CombinedOutput()
	if err != nil {
		os.Remove(transferImagePath)
		return nil, fmt.Errorf("failed to format image: %w, output: %s", err, string(out))
	}

	// Loop mount
	if err := loopMountTransferImage(); err != nil {
		os.Remove(transferImagePath)
		return nil, fmt.Errorf("failed to mount image: %w", err)
	}

	fileTransferState = FileTransferLocallyMounted
	fileTransferLogger.Info().Msg("file transfer drive created and mounted")

	return getFileTransferStateResponseLocked()
}

func rpcFileTransferDeleteDrive() error {
	fileTransferStateMutex.Lock()
	defer fileTransferStateMutex.Unlock()

	if fileTransferState == FileTransferNoDrive {
		return fmt.Errorf("no drive exists")
	}

	// Disconnect from target if connected
	if fileTransferState == FileTransferConnectedTarget {
		if err := setFileTransferImage("\n"); err != nil {
			fileTransferLogger.Warn().Err(err).Msg("failed to disconnect from target")
		}
	}

	// Unmount if mounted
	if fileTransferState == FileTransferLocallyMounted || isTransferImageMounted() {
		if err := unmountTransferImage(); err != nil {
			fileTransferLogger.Warn().Err(err).Msg("failed to unmount transfer image")
		}
	}

	// Remove image file
	if err := os.Remove(transferImagePath); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("failed to remove image file: %w", err)
	}

	fileTransferState = FileTransferNoDrive
	fileTransferLogger.Info().Msg("file transfer drive deleted")
	return nil
}

func rpcFileTransferGetState() (*FileTransferStateResponse, error) {
	fileTransferStateMutex.RLock()
	defer fileTransferStateMutex.RUnlock()

	return getFileTransferStateResponseLocked()
}

func getFileTransferStateResponseLocked() (*FileTransferStateResponse, error) {
	resp := &FileTransferStateResponse{
		State: fileTransferState,
	}

	if fileTransferState == FileTransferLocallyMounted {
		files, err := listTransferFiles()
		if err != nil {
			fileTransferLogger.Warn().Err(err).Msg("failed to list files")
		} else {
			resp.Files = files
		}

		info, err := os.Stat(transferImagePath)
		if err == nil {
			resp.Size = info.Size()
		}

		var used int64
		for _, f := range resp.Files {
			used += f.Size
		}
		resp.Used = used
	} else if fileTransferState != FileTransferNoDrive {
		info, err := os.Stat(transferImagePath)
		if err == nil {
			resp.Size = info.Size()
		}
	}

	return resp, nil
}

func rpcFileTransferConnectToTarget() error {
	fileTransferStateMutex.Lock()
	defer fileTransferStateMutex.Unlock()

	if fileTransferState != FileTransferLocallyMounted {
		return fmt.Errorf("drive must be locally mounted to connect (state: %s)", fileTransferState)
	}

	// Unmount locally first
	if err := unmountTransferImage(); err != nil {
		return fmt.Errorf("failed to unmount for target connection: %w", err)
	}

	// Present to target via USB gadget
	if err := setFileTransferImage(transferImagePath); err != nil {
		// Try to re-mount locally on failure
		_ = loopMountTransferImage()
		return fmt.Errorf("failed to connect to target: %w", err)
	}

	fileTransferState = FileTransferConnectedTarget
	fileTransferLogger.Info().Msg("file transfer drive connected to target")
	return nil
}

func rpcFileTransferDisconnectFromTarget() error {
	fileTransferStateMutex.Lock()
	defer fileTransferStateMutex.Unlock()

	if fileTransferState != FileTransferConnectedTarget {
		return fmt.Errorf("drive is not connected to target (state: %s)", fileTransferState)
	}

	// Disconnect from target
	if err := setFileTransferImage("\n"); err != nil {
		return fmt.Errorf("failed to disconnect from target: %w", err)
	}

	// Re-mount locally
	if err := loopMountTransferImage(); err != nil {
		return fmt.Errorf("failed to re-mount locally: %w", err)
	}

	fileTransferState = FileTransferLocallyMounted
	fileTransferLogger.Info().Msg("file transfer drive disconnected from target")
	return nil
}

func listTransferFiles() ([]FileTransferEntry, error) {
	entries, err := os.ReadDir(transferMountPath)
	if err != nil {
		return nil, fmt.Errorf("failed to read mount dir: %w", err)
	}

	files := make([]FileTransferEntry, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			continue
		}
		files = append(files, FileTransferEntry{
			Name: entry.Name(),
			Size: info.Size(),
		})
	}
	return files, nil
}

func rpcFileTransferListFiles() ([]FileTransferEntry, error) {
	fileTransferStateMutex.RLock()
	defer fileTransferStateMutex.RUnlock()

	if fileTransferState != FileTransferLocallyMounted {
		return nil, fmt.Errorf("drive must be locally mounted to list files (state: %s)", fileTransferState)
	}

	return listTransferFiles()
}

func rpcFileTransferDeleteFile(filename string) error {
	fileTransferStateMutex.RLock()
	defer fileTransferStateMutex.RUnlock()

	if fileTransferState != FileTransferLocallyMounted {
		return fmt.Errorf("drive must be locally mounted to delete files (state: %s)", fileTransferState)
	}

	sanitized, err := sanitizeFilename(filename)
	if err != nil {
		return err
	}

	fullPath := filepath.Join(transferMountPath, sanitized)
	if err := os.Remove(fullPath); err != nil {
		return fmt.Errorf("failed to delete file: %w", err)
	}

	fileTransferLogger.Info().Str("filename", sanitized).Msg("deleted file from transfer drive")
	return nil
}

func initFileTransferState() {
	fileTransferStateMutex.Lock()
	defer fileTransferStateMutex.Unlock()

	// Check if image exists
	if _, err := os.Stat(transferImagePath); os.IsNotExist(err) {
		fileTransferState = FileTransferNoDrive
		fileTransferLogger.Info().Msg("no transfer image found, state: no_drive")
		return
	}

	// Check if lun.1 has an image connected
	lun1Path, err := getFileTransferLun1Path()
	if err != nil {
		fileTransferLogger.Warn().Err(err).Msg("failed to get lun.1 path during init")
		fileTransferState = FileTransferNoDrive
		return
	}

	fileData, err := os.ReadFile(path.Join(lun1Path, "file"))
	if err == nil {
		filePath := strings.TrimSpace(string(fileData))
		if filePath != "" && filePath != "\n" {
			fileTransferState = FileTransferConnectedTarget
			fileTransferLogger.Info().Msg("transfer image connected to target")
			return
		}
	}

	// Check if already loop-mounted
	if isTransferImageMounted() {
		fileTransferState = FileTransferLocallyMounted
		fileTransferLogger.Info().Msg("transfer image already loop-mounted")
		return
	}

	// Image exists but not mounted — try to mount
	if err := loopMountTransferImage(); err != nil {
		fileTransferLogger.Warn().Err(err).Msg("failed to mount existing transfer image on init")
		fileTransferState = FileTransferNoDrive
		return
	}

	fileTransferState = FileTransferLocallyMounted
	fileTransferLogger.Info().Msg("transfer image mounted on init")
}

func handleFileTransferUpload(c *gin.Context) {
	fileTransferStateMutex.RLock()
	state := fileTransferState
	fileTransferStateMutex.RUnlock()

	if state != FileTransferLocallyMounted {
		c.JSON(http.StatusBadRequest, gin.H{"error": "drive must be locally mounted to upload files"})
		return
	}

	file, header, err := c.Request.FormFile("file")
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "no file provided"})
		return
	}
	defer file.Close()

	sanitized, err := sanitizeFilename(header.Filename)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid filename"})
		return
	}

	destPath := filepath.Join(transferMountPath, sanitized)
	out, err := os.Create(destPath)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to create file"})
		return
	}
	defer out.Close()

	if _, err := io.Copy(out, file); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to write file"})
		return
	}

	fileTransferLogger.Info().Str("filename", sanitized).Msg("file uploaded to transfer drive")
	c.JSON(http.StatusOK, gin.H{"filename": sanitized})
}

func handleFileTransferDownload(c *gin.Context) {
	fileTransferStateMutex.RLock()
	state := fileTransferState
	fileTransferStateMutex.RUnlock()

	if state != FileTransferLocallyMounted {
		c.JSON(http.StatusBadRequest, gin.H{"error": "drive must be locally mounted to download files"})
		return
	}

	filename := c.Param("filename")
	sanitized, err := sanitizeFilename(filename)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid filename"})
		return
	}

	fullPath := filepath.Join(transferMountPath, sanitized)
	if _, err := os.Stat(fullPath); os.IsNotExist(err) {
		c.JSON(http.StatusNotFound, gin.H{"error": "file not found"})
		return
	}

	c.FileAttachment(fullPath, sanitized)
}
