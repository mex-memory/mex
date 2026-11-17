package delivery

import (
	"bufio"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"github.com/mex-memory/mex/native/delivery/entries"
	"github.com/mex-memory/mex/native/delivery/rank"
	"github.com/mex-memory/mex/native/index"
	"github.com/mex-memory/mex/native/internal/contract"
	"github.com/mex-memory/mex/native/internal/tokens"
	"github.com/mex-memory/mex/native/record"
)

const anchorPromptBytes = 32 * 1024
const anchorLimit = 24

// Anchor is a lexical candidate until Path is verified against the file index.
// Text is ephemeral: neither prompts nor quoted errors are stored in the record.
type Anchor struct {
	Kind      string `json:"kind"`
	Text      string `json:"text,omitempty"`
	Path      string `json:"path,omitempty"`
	Line      int    `json:"line,omitempty"`
	Signature string `json:"signature,omitempty"`
}

var anchorPathRE = lazy(`(?:[A-Za-z]:)?[A-Za-z0-9_@./\\-]+\.[A-Za-z0-9_]{1,12}(?::[0-9]+(?::[0-9]+)?)?`)
var anchorIDRE = lazy(`[A-Za-z_][A-Za-z0-9_]*`)
var anchorQuoteRE = lazy("`([^`\n]{2,200})`|\"([^\"\n]{4,200})\"|'([^'\n]{4,200})'")

// ExtractAnchors is deterministic and bounded even for pasted logs. Callers pass
// typed text; host envelopes and machine-written turns are excluded once more.
func ExtractAnchors(text string) []Anchor {
	text = rank.PromptText(boundedText(text, anchorPromptBytes))
	if text == "" || rank.Machine(text) {
		return nil
	}
	var out []Anchor
	seen := map[string]bool{}
	add := func(kind, text string, line int) {
		key := kind + ":" + text
		if len(out) < anchorLimit && !seen[key] {
			out = append(out, Anchor{Kind: kind, Text: text, Line: line})
			seen[key] = true
		}
	}
	for _, p := range anchorPathRE().FindAllString(text, 12) {
		p = strings.Trim(p, ".,;()[]{}")
		line := 0
		// Strip column then line without mistaking a drive letter for a range.
		parts := strings.Split(p, ":")
		at := len(parts) - 1
		if at > 0 {
			if _, err := strconv.Atoi(parts[at]); err == nil {
				line, _ = strconv.Atoi(parts[at])
				at--
				if at > 0 {
					if n, err := strconv.Atoi(parts[at]); err == nil {
						line = n
						at--
					}
				}
				p = strings.Join(parts[:at+1], ":")
			}
		}
		add("path", p, line)
	}
	for _, m := range anchorQuoteRE().FindAllStringSubmatch(text, 6) {
		if m[1] != "" {
			add("command", m[1], 0)
		} else {
			add("error", m[2]+m[3], 0)
		}
	}
	for _, name := range anchorIDRE().FindAllString(text, 512) {
		separator := strings.Contains(name, "_")
		camel := strings.IndexAny(name[1:], "ABCDEFGHIJKLMNOPQRSTUVWXYZ") >= 0
		if separator || len(name) >= 6 && camel {
			add("identifier", name, 0)
		}
	}
	return out
}

// VerifyAnchors never builds or repairs an index. A bounded literal search can
// miss an error in a large repo; an unverified candidate always stays silent.
func VerifyAnchors(ev contract.Event, env Environment) []Anchor {
	if ev.Prompt == nil || !ev.Prompt.Typed {
		return nil
	}
	candidates := ExtractAnchors(ev.Prompt.Text)
	if len(candidates) == 0 {
		return nil
	}
	idx := openRescueIndex(env, ev)
	if idx == nil {
		return nil
	}
	defer closeRescueIndex(env, idx)
	var out []Anchor
	for _, a := range candidates {
		switch a.Kind {
		case "path":
			p := filepath.FromSlash(slash(a.Text))
			if !filepath.IsAbs(p) {
				p = filepath.Join(ev.Checkout, p)
			}
			rel, ok := relTo(ev.Checkout, p)
			if !ok || !onDisk(ev.Checkout, rel) || !idx.HasPath(rel) {
				continue
			}
			a.Path = rel
		case "identifier":
			if count := idx.DefinitionCount(a.Text); count < 1 || count > 3 {
				continue
			}
			hits, err := idx.SymbolsNamed(a.Text)
			if err != nil || len(hits) == 0 || len(hits) > 3 {
				continue
			}
			// Every hit can arm its file. Only a globally unique hit gets a pointer.
			for _, hit := range hits {
				found := a
				found.Path, found.Line = hit.Path, hit.Start
				if len(hits) == 1 && idx.DefinitionCount(a.Text) == 1 {
					found.Signature = symbolSignature(ev.Checkout, hit)
					if !wordIn(found.Signature, a.Text) {
						found.Signature = ""
					}
				}
				if onDisk(ev.Checkout, hit.Path) {
					out = append(out, found)
				}
			}
			continue
		case "error", "command":
			p, line := idx.FindLiteral(a.Text)
			if p == "" {
				continue
			}
			a.Path, a.Line = p, line
		}
		out = append(out, a)
	}
	return out
}

func symbolSignature(root string, hit index.SymbolHit) string {
	hit.End = hit.Start
	line := strings.TrimSpace(readSymbol(root, hit, 240))
	return line
}

// Read through an OS containment handle, with bounded scan bytes and line size.
func readSymbol(root string, hit index.SymbolHit, limit int) string {
	if hit.Start < 1 || hit.End < hit.Start {
		return ""
	}
	handle, err := os.OpenRoot(root)
	if err != nil {
		return ""
	}
	defer handle.Close()
	f, err := handle.Open(filepath.FromSlash(hit.Path))
	if err != nil {
		return ""
	}
	defer f.Close()
	stat, err := f.Stat()
	if err != nil || !stat.Mode().IsRegular() || stat.Size() > 4<<20 {
		return ""
	}
	scan := bufio.NewScanner(io.LimitReader(f, 512<<10))
	scan.Buffer(make([]byte, 4096), 65536)
	var lines []string
	size := 0
	line := 0
	for scan.Scan() {
		line++
		if line < hit.Start {
			continue
		}
		text := strings.TrimSuffix(scan.Text(), "\r")
		size += len(text)
		if len(lines) > 0 {
			size++
		}
		if size > limit {
			return ""
		}
		lines = append(lines, text)
		if line == hit.End {
			return strings.Join(lines, "\n")
		}
	}
	return ""
}

func anchorRead(views []toolView, ev contract.Event, env Environment) bool {
	for _, v := range views {
		if v.name == contract.ToolRead && v.output != nil && v.output.OK && record.AnchorPending(env.RecordDirectory, ev.SessionID, ev.AgentID, v.checkout, v.rel) {
			return true
		}
	}
	return false
}

func armAnchors(anchors []Anchor, snap *entries.Snapshot) []candidate {
	var out []candidate
	for i := range snap.Items {
		it := &snap.Items[i]
		if it.NeedsHintGate {
			continue
		}
		var paths []string
		for _, a := range anchors {
			hit := inScope(it, a.Path)
			for _, w := range it.Entry.When {
				if w.Match == "literal" && w.Pattern != "" && strings.Contains(a.Text, w.Pattern) {
					hit = true
				}
			}
			if hit && !contains(paths, a.Path) && len(paths) < 16 {
				paths = append(paths, a.Path)
			}
		}
		if len(paths) > 0 {
			sort.Strings(paths)
			out = append(out, candidate{item: it, moment: "prompt-arm", tier: tierFile, anchorPaths: paths})
		}
	}
	return out
}

type answerCard struct {
	arm               *candidate
	surface, text, id string
	target            record.SurfaceTarget
}

func anchorCard(anchors []Anchor) []answerCard {
	for _, a := range anchors {
		if a.Kind == "identifier" && a.Signature != "" {
			text := fmt.Sprintf("%s:%d %s", a.Path, a.Line, a.Signature)
			return []answerCard{{surface: "prompt-anchor", text: text, id: "mex:anchor:" + contentHash(text)[7:31], target: record.SurfaceTarget{Paths: []string{a.Path}}}}
		}
	}
	return nil
}

func deliverCards(h *record.Hooks, ev contract.Event, env Environment, cards []answerCard) (string, error) {
	if len(cards) == 0 {
		return "", nil
	}
	req := baseRequest(ev, env, ev.ProjectID, ev.Checkout)
	for i := range cards {
		card := cards[i]
		if card.arm != nil {
			req.Candidates = append(req.Candidates, cardCandidate(card))
			continue
		}
		lane := record.LaneFor(record.DeliveryCandidate{Surface: card.surface})
		room, err := h.LaneRoom(ev.SessionID, ev.AgentID, lane)
		if err != nil {
			return "", err
		}
		if card.surface == "search-span" && tokens.Code(card.text)+8 > room {
			parts := strings.SplitN(card.text, "\n", 3)
			if len(parts) >= 2 {
				card.text = fmt.Sprintf("%s:%d-%d %s", card.target.Paths[0], card.target.Start, card.target.Start, strings.TrimSpace(parts[1]))
				card.target.End = card.target.Start
			}
		}
		cards[i] = card
		req.Candidates = append(req.Candidates, cardCandidate(card))
	}
	res, err := h.CheckAndMark(req)
	if err != nil {
		return "", err
	}
	lines := cardLines(cards, res.Receipts)
	if lines == "" {
		return "", nil
	}
	return "[mex " + res.Receipts[0].BlockID + "]\n" + lines, nil
}

func cardCandidate(card answerCard) record.DeliveryCandidate {
	if card.arm != nil {
		c := card.arm
		return record.DeliveryCandidate{EntryID: c.item.Entry.ID, Surface: "prompt-anchor", Moment: "prompt-arm", Form: "one-line", Action: "held-back", Detail: "prompt-anchor", Target: record.SurfaceTarget{Paths: c.anchorPaths}, ContentHash: contentHash(c.item.Hash + "\n"), Title: c.item.Entry.OneLine, Kind: c.item.Entry.Kind}
	}

	return record.DeliveryCandidate{EntryID: card.id, Surface: card.surface, Moment: card.surface, Form: "full", Tokens: tokens.Code(card.text) + 8, ContentHash: contentHash(card.text), Target: card.target, Title: card.surface, Kind: "pointer"}
}

func cardLines(cards []answerCard, receipts []record.Receipt) string {
	var lines []string
	for _, r := range receipts {
		if r.Action == "given" {
			for _, card := range cards {
				if card.id == r.EntryID {
					lines = append(lines, card.text)
				}
			}
		}
	}
	return strings.Join(lines, "\n")
}
