package rank

import "math"

// The learned gate has no initialization work, I/O or external runtime.
func learnedSelect(list []Result) []Result {
	var out []Result
	for i, r := range list[:min(2, len(list))] {
		if len(r.Features) != len(gateWeights) {
			continue
		}
		f := append([]float64(nil), r.Features...)
		second, fourth := 0.0, 0.0
		if len(list) > 1 {
			second = list[1].Score
		}
		if len(list) > 3 {
			fourth = list[3].Score
		}
		f[2] = (r.Score - second) / math.Max(r.Score, .01)
		f[3] = (r.Score - fourth) / math.Max(r.Score, .01)
		f[len(f)-1] = float64(i)
		z := 0.0
		for j, v := range f {
			z += math.Max(-20, math.Min(20, (v-gateMeans[j])/gateScales[j])) * gateWeights[j]
		}
		if 1/(1+math.Exp(-math.Max(-30, math.Min(30, z)))) >= gateThreshold {
			out = append(out, r)
		}
	}
	return out
}
