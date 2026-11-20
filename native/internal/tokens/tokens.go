// Package tokens contains the shared deterministic estimates. These are budget
// units, not tokenizer counts. UTF-8 bytes conservatively cover non-ASCII text.
package tokens

const CodeCharsPerToken = 2.3
const ProseCharsPerToken = 4

func Code(text string) int { return CodeBytes(len(text)) }

// CodeBytes estimates already measured output sizes without allocating text.
func CodeBytes(size int) int {
	denominator := int(CodeCharsPerToken * 10)
	return (size*10 + denominator - 1) / denominator
}
func Prose(text string) int { return (len(text) + ProseCharsPerToken - 1) / ProseCharsPerToken }
