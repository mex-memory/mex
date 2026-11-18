package hook

import (
	"errors"
	"os"
	"strconv"

	"github.com/mex-memory/mex/native/index/shift"
	"github.com/mex-memory/mex/native/internal/contract"
	"github.com/mex-memory/mex/native/record/place"
)

// maxShiftFileBytes caps how much of an edited file the hook reads to place a
// hunk. Bigger files are marked changed until the re-parse.
const maxShiftFileBytes = 4 << 20

var errNoDetection = errors.New("network detection is skipped on the hook path")

// noteEdit keeps the file index exact after an edit: for each edited file in an
// indexed checkout it writes a line shift, so outlines stay right until the
// background re-parse. It never parses, never opens a database, and ignores
// every error.
func noteEdit(ev contract.Event, recordDirectory string) {
	if recordDirectory == "" || ev.Kind != contract.PostTool || ev.Tool == nil || ev.Tool.Output == nil || !ev.Tool.Output.OK {
		return
	}
	edits := editsOf(*ev.Tool)
	if len(edits) == 0 {
		return
	}
	location := place.Location{Directory: recordDirectory}
	wrote := false
	for _, edit := range edits {
		checkout, found := shift.FindCheckout(location.Directory, edit.path)
		if !found {
			continue
		}
		rel, ok := place.RelativeToCheckout(checkout.Root, edit.path)
		if !ok {
			continue
		}
		info, err := os.Stat(edit.path)
		if err != nil {
			continue
		}
		record := shift.Shift{Path: rel, MtimeNS: strconv.FormatInt(info.ModTime().UnixNano(), 10), Ranges: []shift.Range{}}
		ranges, placed := edit.ranges, edit.placed
		if !placed && len(edit.hunks) > 0 && info.Size() <= maxShiftFileBytes {
			if after, err := os.ReadFile(edit.path); err == nil {
				ranges, placed = shift.RangesFromHunks(string(after), edit.hunks, shift.LangOf(edit.path))
			}
		}
		if placed {
			if len(ranges) == 0 {
				continue
			}
			record.Ranges = ranges
		} else {
			record.Unknown = true
		}
		if shift.WriteShift(shift.Directory(location.Directory, checkout.ProjectID), checkout.Key, record) == nil {
			wrote = true
		}
	}
	if wrote {
		shift.MarkPending(location.Directory)
	}
}

type fileEdit struct {
	path   string
	ranges []shift.Range
	placed bool
	hunks  []shift.Hunk
}

// editsOf lists the files a tool changed, with exact ranges when the agent
// reported them, or the hunks to place.
func editsOf(tool contract.Tool) []fileEdit {
	switch tool.Name {
	case contract.ToolEdit, contract.ToolWrite:
		if tool.Input.Path == "" {
			return nil
		}
		edit := fileEdit{path: tool.Input.Path}
		if ranges, ok := shift.RangesFromStructuredPatch(tool.Output.Text, shift.LangOf(tool.Input.Path)); ok {
			edit.ranges, edit.placed = ranges, true
		} else if tool.Name == contract.ToolEdit && tool.Input.Old != nil && tool.Input.New != nil {
			edit.hunks = []shift.Hunk{{Old: *tool.Input.Old, New: *tool.Input.New}}
		}
		// A Write without a patch is a new file or an unknown rewrite: unknown,
		// which a file the index doesn't have simply ignores.
		return []fileEdit{edit}
	case contract.ToolPatch:
		var edits []fileEdit
		for _, file := range tool.Input.Files {
			if file.Path == "" {
				continue
			}
			edit := fileEdit{path: file.Path}
			for _, hunk := range file.Hunks {
				edit.hunks = append(edit.hunks, shift.Hunk{Old: hunk.Old, New: hunk.New})
			}
			edits = append(edits, edit)
		}
		return edits
	}
	return nil
}
