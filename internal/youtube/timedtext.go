package youtube

import (
	"context"
	"encoding/xml"
	"html"
)

// timedTextDoc models YouTube's legacy timedtext XML (srv1) caption format.
type timedTextDoc struct {
	XMLName xml.Name `xml:"transcript"`
	Texts   []struct {
		Start    float64 `xml:"start,attr"`
		Duration float64 `xml:"dur,attr"`
		Body     string  `xml:",chardata"`
	} `xml:"text"`
}

// fetchTimedTextXML downloads and parses the srv1 XML caption format,
// used as a fallback when json3 is unavailable.
func (c *Client) fetchTimedTextXML(ctx context.Context, baseURL string) ([]TranscriptSegment, error) {
	data, err := c.captionGet(ctx, baseURL)
	if err != nil {
		return nil, err
	}
	if len(data) == 0 {
		return nil, nil
	}
	var doc timedTextDoc
	if err := xml.Unmarshal(data, &doc); err != nil {
		return nil, &ExtractError{Code: "CAPTION_PARSE_ERROR", Retryable: true,
			Message: "Could not parse the caption track returned by YouTube",
			Details: map[string]any{"cause": err.Error()}}
	}
	var segments []TranscriptSegment
	for _, t := range doc.Texts {
		text := normalizeCaptionText(html.UnescapeString(t.Body))
		if text == "" {
			continue
		}
		segments = append(segments, TranscriptSegment{Text: text, Start: t.Start, Duration: t.Duration})
	}
	return segments, nil
}
