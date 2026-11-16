package delivery

import (
	"os"
	"testing"

	"github.com/mex-memory/mex/native/record"
)

// These tests check what delivery sends, not how fast; record's own tests
// and the timing benchmarks hold the production deadlines.
func TestMain(m *testing.M) {
	record.UseBehaviorTestBudget()
	os.Exit(m.Run())
}
