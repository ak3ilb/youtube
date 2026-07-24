package youtube

import (
	"context"
	"encoding/xml"
	"html"
	"strings"
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

// timedTextFmt3 models YouTube's srv3 <timedtext> XML.
type timedTextFmt3 struct {
	XMLName xml.Name `xml:"timedtext"`
	Body    struct {
		Paragraphs []struct {
			StartMs  float64 `xml:"t,attr"`
			Duration float64 `xml:"d,attr"`
			Text     string  `xml:",chardata"`
			Spans    []struct {
				Text string `xml:",chardata"`
			} `xml:"s"`
		} `xml:"p"`
	} `xml:"body"`
}

// fetchTimedTextXML downloads and parses srv1 or srv3 caption XML.
func (c *Client) fetchTimedTextXML(ctx context.Context, baseURL string) ([]TranscriptSegment, error) {
	data, err := c.captionGet(ctx, baseURL)
	if err != nil {
		return nil, err
	}
	if len(data) == 0 {
		return nil, nil
	}
	raw := string(data)
	if strings.Contains(raw, "<transcript") {
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
	if strings.Contains(raw, "<timedtext") {
		var doc timedTextFmt3
		if err := xml.Unmarshal(data, &doc); err != nil {
			return nil, &ExtractError{Code: "CAPTION_PARSE_ERROR", Retryable: true,
				Message: "Could not parse the caption track returned by YouTube",
				Details: map[string]any{"cause": err.Error()}}
		}
		var segments []TranscriptSegment
		for _, p := range doc.Body.Paragraphs {
			var b strings.Builder
			b.WriteString(p.Text)
			for _, s := range p.Spans {
				b.WriteString(s.Text)
			}
			text := normalizeCaptionText(html.UnescapeString(b.String()))
			if text == "" {
				continue
			}
			segments = append(segments, TranscriptSegment{
				Text: text, Start: p.StartMs / 1000, Duration: p.Duration / 1000,
			})
		}
		return segments, nil
	}
	return nil, &ExtractError{Code: "CAPTION_PARSE_ERROR", Retryable: true,
		Message: "YouTube returned an unrecognized caption format",
		Details: map[string]any{"head": raw[:min(120, len(raw))]}}
}
