package record

import "github.com/mex-memory/mex/native/record/place"

// Location and the path helpers live in package place, which has no database
// code (the hook shim uses it without linking SQLite). These keep record's API.

type Location = place.Location
type LocationOptions = place.LocationOptions

func ResolveLocation(options LocationOptions) (Location, error) {
	return place.ResolveLocation(options)
}
func ProjectDataDirectory(location Location, id string) (string, error) {
	return place.ProjectDataDirectory(location, id)
}
func ShortHash(value string) string        { return place.ShortHash(value) }
func RealPath(path string) (string, error) { return place.RealPath(path) }
func RelativeToCheckout(root, file string) (string, bool) {
	return place.RelativeToCheckout(root, file)
}

func shortHash(value string) string            { return place.ShortHash(value) }
func absolutePath(path string) (string, error) { return place.AbsolutePath(path) }
func realPath(path string) (string, error)     { return place.RealPath(path) }
func homeDir() (string, error)                 { return place.HomeDir() }
