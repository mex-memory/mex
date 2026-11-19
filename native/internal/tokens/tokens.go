// Package tokens contains the shared deterministic estimates. These are budget
// units, not tokenizer counts. UTF-8 bytes conservatively cover non-ASCII text.
package tokens

const CodeCharsPerToken = 2.3
const ProseCharsPerToken = 4

func Code(text string) int {
	denominator := int(CodeCharsPerToken * 10)
	return (len(text)*10 + denominator - 1) / denominator
}
func Prose(text string) int { return (len(text) + ProseCharsPerToken - 1) / ProseCharsPerToken }
