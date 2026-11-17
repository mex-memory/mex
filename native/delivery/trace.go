package delivery

import "time"

// phase does no clock work unless the explicit diagnostic mode is enabled.
func phase(trace func(string, time.Duration), name string) func() {
	if trace == nil {
		return func() {}
	}
	start := time.Now()
	return func() { trace(name, time.Since(start)) }
}
