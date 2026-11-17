package record

import (
	"context"
	"fmt"
	"os"
	"sort"
	"strings"
)

type WhatItem struct {
	ID     string `json:"id"`
	Title  string `json:"title"`
	Kind   string `json:"kind"`
	Level  string `json:"level"`
	Action string `json:"action"`
	Detail string `json:"detail"`
}
type WhatSummary struct {
	Session          string     `json:"session"`
	Gave             int        `json:"gave"`
	Withheld         int        `json:"withheld"`
	Replaced         int        `json:"replaced"`
	Items            []WhatItem `json:"items"`
	EstimatedFalse   int        `json:"estimatedFalse"`
	ClosedDeliveries int        `json:"closedDeliveries"`
	Partial          bool       `json:"partial"`
}

func (s WhatSummary) Line() string {
	kinds := map[string]int{}
	for _, it := range s.Items {
		if it.Action != "given" && it.Action != "replaced" {
			continue
		}
		name := it.Kind
		if name == "rule" && it.Level == "team" {
			name = "team rule"
		}
		if name == "rule" && it.Level == "personal" {
			name = "note"
		}
		if name != "" {
			kinds[name]++
		}
	}
	names := []string{}
	for k := range kinds {
		names = append(names, k)
	}
	sort.Strings(names)
	parts := []string{}
	for _, name := range names {
		suffix := ""
		if kinds[name] != 1 {
			suffix = "s"
		}
		parts = append(parts, fmt.Sprintf("%d %s%s", kinds[name], name, suffix))
	}
	detail := ""
	if len(parts) > 0 {
		detail = " (" + strings.Join(parts, ", ") + ")"
	}
	qualifier := ""
	if s.Partial {
		qualifier = "at least "
	}
	return fmt.Sprintf("MEX · this session: gave %s%d items%s · withheld %s%d out of date · replaced %s%d long outputs · details: mex hub", qualifier, s.Gave, detail, qualifier, s.Withheld, qualifier, s.Replaced)
}

// ReadWhat never creates or migrates storage. The bounded projection contains
// entry titles, never entry bodies, prompts or commands.
func ReadWhat(file, session, project, checkout string) (WhatSummary, error) {
	out := WhatSummary{Session: session, Items: []WhatItem{}}
	if _, err := os.Stat(file); os.IsNotExist(err) {
		return out, nil
	}
	db, err := openDatabase(file, true)
	if err != nil {
		return out, err
	}
	defer db.Close()
	ctx, cancel := context.WithTimeout(context.Background(), ReaderOperationTimeout)
	defer cancel()
	version, err := schemaVersion(ctx, db)
	if err != nil {
		return out, err
	}
	if version > SchemaVersion {
		return out, futureSchema("hooks.db", version)
	}
	if session == "" {
		err = db.QueryRowContext(ctx, `SELECT session_id FROM sessions WHERE project_id=? AND checkout=? ORDER BY last_seen_at DESC,session_id LIMIT 1`, project, checkout).Scan(&out.Session)
		if err != nil {
			return out, nil
		}
	}
	columns := `entry_id,'' AS title,'' AS kind,'' AS level,action,'' AS detail,0,0`
	if version >= 5 {
		columns = `d.entry_id,d.title,d.kind,d.level,d.action,d.detail,
 CASE WHEN e.closed=1 AND d.action IN ('given','replaced') AND NOT EXISTS(SELECT 1 FROM followups f WHERE f.delivery_id=d.id) AND NOT EXISTS(SELECT 1 FROM delivery_touches t WHERE t.delivery_id=d.id) THEN 1 ELSE 0 END,
 CASE WHEN e.closed=1 AND d.action IN ('given','replaced') THEN 1 ELSE 0 END`
	}
	rows, err := db.QueryContext(ctx, `SELECT `+columns+` FROM deliveries d JOIN epochs e ON e.session_id=d.session_id AND e.agent_id=d.agent_id AND e.epoch=d.epoch WHERE d.session_id=? AND d.project_id=? AND d.checkout=? AND d.moment<>'correction' ORDER BY d.rowid LIMIT 401`, out.Session, project, checkout)
	if err != nil {
		return out, err
	}
	defer rows.Close()
	for rows.Next() {
		var it WhatItem
		var empty, closed int
		if err = rows.Scan(&it.ID, &it.Title, &it.Kind, &it.Level, &it.Action, &it.Detail, &empty, &closed); err != nil {
			return out, err
		}
		if len(out.Items) == 400 {
			out.Partial = true
			break
		}
		it.Title = strings.Join(strings.Fields(it.Title), " ")
		if len(it.Title) > 1024 {
			it.Title = it.Title[:1024]
		}
		out.Items = append(out.Items, it)
		out.EstimatedFalse += empty
		out.ClosedDeliveries += closed
		switch it.Action {
		case "given", "replaced":
			out.Gave++
		case "withheld":
			if it.Detail == "" {
				out.Withheld++
			}
		}
	}
	return out, rows.Err()
}
