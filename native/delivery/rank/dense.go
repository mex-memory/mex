package rank

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"math"
	"os"
	"path/filepath"
	"strings"
	"unicode"
)

// StaticModel performs bounded WordPiece lookup and mean pooling, with no
// inference runtime. Quantization is per row, symmetric int8; matrices stay
// on disk and only the selected vocabulary rows are read. No model is bundled.
type StaticModel struct {
	f         *os.File
	vocab     map[string]int
	dim, rows int
	offset    int64
	cache     map[int][]float32
}

func boundedFile(path string, limit int64) ([]byte, error) {
	f, e := os.Open(path)
	if e != nil {
		return nil, e
	}
	defer f.Close()
	s, e := f.Stat()
	if e != nil || !s.Mode().IsRegular() || s.Size() > limit {
		return nil, errors.New("invalid model metadata")
	}
	return io.ReadAll(io.LimitReader(f, limit+1))
}
func OpenStatic(dir string, dims int) (*StaticModel, error) {
	b, e := boundedFile(filepath.Join(dir, "tokenizer.json"), 8<<20)
	if e != nil {
		return nil, e
	}
	var tok struct {
		Model struct {
			Type  string         `json:"type"`
			Vocab map[string]int `json:"vocab"`
		} `json:"model"`
	}
	if json.Unmarshal(b, &tok) != nil || tok.Model.Type != "WordPiece" || len(tok.Model.Vocab) > 100000 {
		return nil, errors.New("unsupported static tokenizer")
	}
	f, e := os.Open(filepath.Join(dir, "model.safetensors"))
	if e != nil {
		return nil, e
	}
	fail := func(e error) (*StaticModel, error) { f.Close(); return nil, e }
	var size [8]byte
	if _, e = io.ReadFull(f, size[:]); e != nil {
		return fail(e)
	}
	n := binary.LittleEndian.Uint64(size[:])
	if n > 65536 {
		return fail(errors.New("model header exceeds bound"))
	}
	header := make([]byte, int(n))
	if _, e = io.ReadFull(f, header); e != nil {
		return fail(e)
	}
	var tensors map[string]json.RawMessage
	if json.Unmarshal(header, &tensors) != nil {
		return fail(errors.New("invalid tensor header"))
	}
	for _, name := range []string{"embeddings", "embedding.weight"} {
		var t struct {
			DType   string  `json:"dtype"`
			Shape   []int   `json:"shape"`
			Offsets []int64 `json:"data_offsets"`
		}
		if json.Unmarshal(tensors[name], &t) != nil || t.DType != "F32" || len(t.Shape) != 2 || len(t.Offsets) != 2 {
			continue
		}
		if t.Shape[0] < 1 || t.Shape[0] > 100000 || t.Shape[1] < 1 || t.Shape[1] > 2048 || t.Offsets[1]-t.Offsets[0] != int64(t.Shape[0])*int64(t.Shape[1])*4 {
			return fail(errors.New("invalid tensor dimensions"))
		}
		info, e := f.Stat()
		if e != nil || 8+int64(n)+t.Offsets[1] > info.Size() {
			return fail(errors.New("truncated tensor"))
		}
		// Original stride is retained when a model supports truncated dimensions.
		return &StaticModel{f: f, vocab: tok.Model.Vocab, dim: t.Shape[1], rows: t.Shape[0], offset: 8 + int64(n) + t.Offsets[0], cache: map[int][]float32{}}, nil
	}
	return fail(errors.New("no supported static tensor"))
}
func (m *StaticModel) Close() error { return m.f.Close() }
func (m *StaticModel) pieces(text string) []int {
	var words []string
	var word strings.Builder
	flush := func() {
		if word.Len() > 0 {
			words = append(words, word.String())
			word.Reset()
		}
	}
	for _, r := range strings.ToLower(text) {
		if unicode.IsSpace(r) || unicode.IsControl(r) {
			flush()
			continue
		}
		if unicode.Is(unicode.Mn, r) {
			continue
		}
		accents, plain := "àáâãäåèéêëìíîïòóôõöùúûüñçýÿ", "aaaaaaeeeeiiiiooooouuuuncyy"
		if i := strings.IndexRune(accents, r); i >= 0 {
			r = rune(plain[len([]rune(accents[:i]))])
		}
		if unicode.IsPunct(r) || unicode.IsSymbol(r) || unicode.Is(unicode.Han, r) {
			flush()
			words = append(words, string(r))
		} else {
			word.WriteRune(r)
		}
	}
	flush()
	var out []int
	for _, word := range words {
		if len(out) >= 256 {
			break
		}
		chars := []rune(word)
		if len(chars) > 100 {
			continue
		}
		var ids []int
		for start := 0; start < len(chars); {
			end := len(chars)
			found := -1
			for end > start {
				piece := string(chars[start:end])
				if start > 0 {
					piece = "##" + piece
				}
				if id, ok := m.vocab[piece]; ok {
					found = id
					break
				}
				end--
			}
			if found < 0 {
				ids = nil
				break
			}
			ids = append(ids, found)
			start = end
		}
		out = append(out, ids...)
	}
	return out[:min(256, len(out))]
}
func (m *StaticModel) Embed(text string, dims int) ([]float32, error) {
	if dims <= 0 || dims > m.dim {
		dims = m.dim
	}
	out := make([]float32, dims)
	for _, id := range m.pieces(text) {
		if id < 0 || id >= m.rows {
			return nil, errors.New("token outside matrix")
		}
		row := m.cache[id]
		if row == nil {
			data := make([]byte, m.dim*4)
			if _, e := m.f.ReadAt(data, m.offset+int64(id*m.dim*4)); e != nil {
				return nil, e
			}
			row = make([]float32, m.dim)
			peak := float32(0)
			for i := range row {
				row[i] = math.Float32frombits(binary.LittleEndian.Uint32(data[i*4:]))
				if float32(math.Abs(float64(row[i]))) > peak {
					peak = float32(math.Abs(float64(row[i])))
				}
			}
			if peak > 0 {
				for i := range row {
					row[i] = float32(math.Round(float64(row[i]/peak*127))) * peak / 127
				}
			}
			if len(m.cache) < 2048 {
				m.cache[id] = row
			}
		}
		for i := range out {
			out[i] += row[i]
		}
	}
	norm := 0.0
	for _, v := range out {
		norm += float64(v) * float64(v)
	}
	if norm > 0 {
		norm = math.Sqrt(norm)
		for i := range out {
			out[i] /= float32(norm)
		}
	}
	return out, nil
}
func Dot(a, b []float32) float64 {
	if len(a) != len(b) {
		return -1
	}
	sum := 0.0
	for i, v := range a {
		sum += float64(v) * float64(b[i])
	}
	return sum
}
func DenseText(d Doc) string {
	return d.Title + ". " + d.Text + " " + strings.Join(d.Scope, " ") + " " + strings.Join(d.Aliases, " ")
}
