package check

import (
	"errors"
	"strings"
	"unicode"
	"unicode/utf16"
	"unicode/utf8"
)

var distributionName = lazy(`^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$`)
var distributionPrefix = lazy(`^([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)(.*)$`)
var versionClause = lazy(`^(?:===|~=|==|!=|<=|>=|<|>)\s*[A-Za-z0-9.*_+!-]+$`)
var errMember = errors.New("unsupported dependency container or requirement name")

func memberName(v any) (string, bool) {
	s, ok := v.(string)
	return s, ok && len(s) > 0 && len(utf16.Encode([]rune(s))) <= 512 && utf8.ValidString(s) && strings.TrimSpace(s) == s && !strings.ContainsRune(s, '\uFEFF') && strings.IndexFunc(s, unicode.IsControl) < 0
}
func normalizedDistribution(s string) string {
	return strings.ToLower(strings.Join(strings.FieldsFunc(s, func(r rune) bool { return r == '-' || r == '_' || r == '.' }), "-"))
}

// requirementName extracts the declared name, not the installed version or
// environment applicability. It never resolves a direct reference or a marker.
func requirementName(s string) (string, error) {
	if strings.IndexFunc(s, func(r rune) bool { return unicode.IsControl(r) && r != '\t' }) >= 0 {
		return "", errMember
	}
	m := distributionPrefix().FindStringSubmatch(strings.TrimSpace(s))
	if m == nil {
		return "", errMember
	}
	rest := strings.TrimSpace(m[2])
	if strings.HasPrefix(rest, "[") {
		end := strings.IndexByte(rest, ']')
		if end < 0 {
			return "", errMember
		}
		extras := strings.TrimSpace(rest[1:end])
		if extras != "" {
			for _, extra := range strings.Split(extras, ",") {
				if !distributionName().MatchString(strings.TrimSpace(extra)) {
					return "", errMember
				}
			}
		}
		rest = strings.TrimSpace(rest[end+1:])
	}
	constraint, marker, hasMarker := strings.Cut(rest, ";")
	if hasMarker && strings.TrimSpace(marker) == "" {
		return "", errMember
	}
	constraint = strings.TrimSpace(constraint)
	if strings.HasPrefix(constraint, "@") {
		ref := strings.TrimSpace(constraint[1:])
		if ref == "" || strings.IndexFunc(ref, unicode.IsSpace) >= 0 {
			return "", errMember
		}
	} else if constraint != "" {
		if strings.HasPrefix(constraint, "(") && strings.HasSuffix(constraint, ")") {
			constraint = strings.TrimSpace(constraint[1 : len(constraint)-1])
		}
		clauses := strings.Split(strings.TrimSuffix(constraint, ","), ",")
		for _, clause := range clauses {
			if !versionClause().MatchString(strings.TrimSpace(clause)) {
				return "", errMember
			}
		}
	}
	return normalizedDistribution(m[1]), nil
}

func dependencyMember(value any, name string) (bool, error) {
	switch v := value.(type) {
	case map[string]any:
		_, found := v[name]
		return found, nil
	case []any:
		if !distributionName().MatchString(name) {
			return false, errMember
		}
		wanted, found := normalizedDistribution(name), false
		for _, item := range v {
			s, ok := item.(string)
			if !ok {
				return false, errMember
			}
			declared, err := requirementName(s)
			if err != nil {
				return false, err
			}
			found = found || declared == wanted
		}
		return found, nil
	}
	return false, errMember
}
