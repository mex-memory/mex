package record

import (
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
)

type Location struct {
	Home      string `json:"home"`
	Directory string `json:"directory"`
	Record    string `json:"record"`
	Hooks     string `json:"hooks"`
}

var regexpProjectID = regexp.MustCompile(`^[gf]-[a-f0-9]{24}$`)

type LocationOptions struct {
	Home      string
	Cache     string
	IsNetwork func(string) (bool, error)
	ReadOnly  bool
}

func homeDir() (string, error) {
	if override := strings.TrimSpace(os.Getenv("MEX_HOME")); override != "" {
		return absolutePath(filepath.Join(override, ".mex"))
	}
	user, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return absolutePath(filepath.Join(user, ".mex"))
}

func cacheRoot() (string, error) {
	user, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	switch runtime.GOOS {
	case "windows":
		local := os.Getenv("LOCALAPPDATA")
		if local == "" {
			local = filepath.Join(user, "AppData", "Local")
		}
		return filepath.Join(local, "mex"), nil
	case "darwin":
		return filepath.Join(user, "Library", "Caches", "mex"), nil
	default:
		local := os.Getenv("XDG_CACHE_HOME")
		if local == "" {
			local = filepath.Join(user, ".cache")
		}
		return filepath.Join(local, "mex"), nil
	}
}

func readPointer(pointer, home, cache string) string {
	info, err := os.Stat(pointer)
	if err != nil || info.Size() > 4096 {
		return ""
	}
	data, err := os.ReadFile(pointer)
	if err != nil {
		return ""
	}
	text := strings.TrimSpace(string(data))
	if !filepath.IsAbs(text) || strings.ContainsRune(text, 0) {
		return ""
	}
	candidate, err := locationPath(text)
	if err == nil && (candidate == home || candidate == cache) {
		return candidate
	}
	return ""
}

func locationPath(path string) (string, error) {
	existing, err := absolutePath(path)
	if err != nil {
		return "", err
	}
	suffix := []string{}
	for {
		if _, err := os.Stat(existing); err == nil {
			break
		}
		parent := filepath.Dir(existing)
		if parent == existing {
			return absolutePath(path)
		}
		suffix = append([]string{filepath.Base(existing)}, suffix...)
		existing = parent
	}
	real, err := realPath(existing)
	if err != nil {
		return "", err
	}
	return filepath.Join(append([]string{real}, suffix...)...), nil
}

// ResolveLocation never shells out. A cached pointer skips filesystem detection.
func ResolveLocation(options LocationOptions) (Location, error) {
	home, err := homeDir()
	if options.Home != "" {
		home, err = absolutePath(options.Home)
	}
	if err != nil {
		return Location{}, err
	}
	home, err = locationPath(home)
	if err != nil {
		return Location{}, err
	}
	cache := options.Cache
	if cache == "" {
		cache, err = cacheRoot()
		if err != nil {
			return Location{}, err
		}
	}
	cache, err = locationPath(filepath.Join(cache, shortHash(home)))
	if err != nil {
		return Location{}, err
	}
	pointer := filepath.Join(home, "location")
	directory := readPointer(pointer, home, cache)
	if directory == "" {
		detector := options.IsNetwork
		if detector == nil {
			detector = isNetworkHome
		}
		network, detectErr := detector(home)
		directory = home
		if detectErr == nil && network {
			directory = cache
		}
		if !options.ReadOnly {
			if err = os.MkdirAll(home, 0700); err != nil {
				return Location{}, err
			}
			file, openErr := os.OpenFile(pointer, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
			if openErr == nil {
				_, writeErr := file.WriteString(directory + "\n")
				closeErr := file.Close()
				if writeErr != nil {
					return Location{}, writeErr
				}
				if closeErr != nil {
					return Location{}, closeErr
				}
			} else if !errors.Is(openErr, os.ErrExist) {
				return Location{}, openErr
			}
			if published := readPointer(pointer, home, cache); published != "" {
				directory = published
			}
		}
	}
	if !options.ReadOnly {
		if err = os.MkdirAll(directory, 0700); err != nil {
			return Location{}, err
		}
	}
	return Location{home, directory, filepath.Join(directory, "record.db"), filepath.Join(directory, "hooks.db")}, nil
}

func ProjectDataDirectory(location Location, id string) (string, error) {
	if !regexpProjectID.MatchString(id) {
		return "", errors.New("invalid project id")
	}
	path := filepath.Join(location.Home, "projects", id)
	return path, os.MkdirAll(path, 0700)
}
