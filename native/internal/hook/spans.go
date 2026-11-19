package hook

import (
	"bufio"
	"encoding/json"
	"github.com/mex-memory/mex/native/delivery"
	"github.com/mex-memory/mex/native/internal/contract"
	"io"
)

func spanStudy(in io.Reader, out io.Writer) int {
	scan := bufio.NewScanner(in)
	scan.Buffer(make([]byte, 65536), maxPayload)
	enc := json.NewEncoder(out)
	for scan.Scan() {
		var req struct {
			Directory string         `json:"record_directory"`
			Event     contract.Event `json:"event"`
		}
		if json.Unmarshal(scan.Bytes(), &req) != nil {
			return 2
		}
		spans := delivery.StudySpans(req.Event, delivery.Environment{RecordDirectory: req.Directory})
		if enc.Encode(spans) != nil {
			return 1
		}
	}
	if scan.Err() != nil {
		return 2
	}
	return 0
}
