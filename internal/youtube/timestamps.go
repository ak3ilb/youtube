package youtube

import (
	"fmt"
	"strconv"
	"strings"
)

// FormatTimestamp converts seconds to YouTube-style "M:SS" or "H:MM:SS".
func FormatTimestamp(seconds float64) string {
	if seconds < 0 {
		seconds = 0
	}
	total := int(seconds + 0.5)
	h, m, s := total/3600, (total%3600)/60, total%60
	if h > 0 {
		return fmt.Sprintf("%d:%02d:%02d", h, m, s)
	}
	return fmt.Sprintf("%d:%02d", m, s)
}

// ParseTimestamp parses "M:SS", "MM:SS", or "H:MM:SS" into seconds.
func ParseTimestamp(s string) (float64, error) {
	s = strings.TrimSpace(s)
	parts := strings.Split(s, ":")
	if len(parts) < 2 || len(parts) > 3 {
		return 0, &ExtractError{Code: "INVALID_TIMESTAMP",
			Message: fmt.Sprintf("Expected a timestamp like 1:30 or 1:02:03, got %q", s)}
	}
	var h, m, sec int
	var err error
	switch len(parts) {
	case 2:
		m, err = strconv.Atoi(parts[0])
		if err != nil {
			return 0, &ExtractError{Code: "INVALID_TIMESTAMP", Message: "Invalid minutes in timestamp: " + s}
		}
		sec, err = strconv.Atoi(parts[1])
	case 3:
		h, err = strconv.Atoi(parts[0])
		if err != nil {
			return 0, &ExtractError{Code: "INVALID_TIMESTAMP", Message: "Invalid hours in timestamp: " + s}
		}
		m, err = strconv.Atoi(parts[1])
		if err != nil {
			return 0, &ExtractError{Code: "INVALID_TIMESTAMP", Message: "Invalid minutes in timestamp: " + s}
		}
		sec, err = strconv.Atoi(parts[2])
	}
	if err != nil || sec < 0 || sec > 59 || m < 0 || m > 59 || h < 0 {
		return 0, &ExtractError{Code: "INVALID_TIMESTAMP", Message: "Invalid timestamp value: " + s}
	}
	return float64(h*3600 + m*60 + sec), nil
}
