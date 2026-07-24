package youtube

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

func formatsFromPlayer(p *playerResponse) []Format {
	raw := append(append([]rawFormat{}, p.StreamingData.Formats...), p.StreamingData.AdaptiveFormats...)
	formats := make([]Format, 0, len(raw))
	for _, f := range raw {
		length, _ := strconv.ParseUint(f.ContentLength, 10, 64)
		mime := strings.ToLower(f.MimeType)
		formats = append(formats, Format{
			Itag:          f.Itag,
			MimeType:      f.MimeType,
			Quality:       f.Quality,
			QualityLabel:  f.QualityLabel,
			AudioQuality:  f.AudioQuality,
			Bitrate:       f.Bitrate,
			ContentLength: length,
			HasAudio:      strings.HasPrefix(mime, "audio/") || f.AudioQuality != "",
			HasVideo:      strings.HasPrefix(mime, "video/"),
			DirectURL:     f.URL != "",
			StreamURL:     f.URL,
		})
	}
	sort.SliceStable(formats, func(i, j int) bool { return formats[i].Itag < formats[j].Itag })
	return formats
}

// Formats lists stream formats. Formats without DirectURL would need
// sig/nsig JS-challenge solving (WEB client), which is out of scope.
func (c *Client) Formats(ctx context.Context, input string) ([]Format, string, error) {
	id, err := ParseVideoID(input)
	if err != nil {
		return nil, "", err
	}
	p, clientName, err := c.fetchPlayer(ctx, id)
	if err != nil {
		return nil, "", err
	}
	return formatsFromPlayer(p), clientName, nil
}

// Download fetches one format (by itag, or best muxed if itag==0) to outPath.
func (c *Client) Download(ctx context.Context, input string, itag int, outPath string) (*DownloadResult, error) {
	formats, _, err := c.Formats(ctx, input)
	if err != nil {
		return nil, err
	}
	var chosen *Format
	if itag > 0 {
		for i := range formats {
			if formats[i].Itag == itag {
				chosen = &formats[i]
				break
			}
		}
		if chosen == nil {
			return nil, &ExtractError{Code: "FORMAT_NOT_FOUND",
				Message: fmt.Sprintf("No format with itag %d exists for this video; call formats to list available itags", itag),
				Details: map[string]any{"itag": itag}}
		}
	} else {
		// Best muxed (audio+video) format with a direct URL.
		for i := range formats {
			f := &formats[i]
			if f.HasAudio && f.HasVideo && f.DirectURL && (chosen == nil || f.Bitrate > chosen.Bitrate) {
				chosen = f
			}
		}
		if chosen == nil {
			return nil, &ExtractError{Code: "NO_MUXED_FORMAT",
				Message: "No combined audio+video format with a direct URL is available; pick an itag from formats instead"}
		}
	}
	if !chosen.DirectURL {
		return nil, &ExtractError{Code: "SIGNATURE_REQUIRED",
			Message: fmt.Sprintf("Format %d is protected by YouTube's sig/nsig JavaScript challenge, which this extractor does not solve; choose a format where directUrl is true", chosen.Itag),
			Details: map[string]any{"itag": chosen.Itag}}
	}
	if err := os.MkdirAll(filepath.Dir(outPath), 0o755); err != nil {
		return nil, &ExtractError{Code: "WRITE_ERROR", Message: "Could not create the output directory: " + err.Error()}
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, chosen.StreamURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", androidUserAgent)
	// Media downloads can far exceed the metadata timeout, so use a client
	// without an overall deadline; cancellation still flows through ctx.
	mediaClient := &http.Client{}
	resp, err := mediaClient.Do(req)
	if err != nil {
		return nil, classifyNetworkError(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusPartialContent {
		return nil, httpStatusError(resp.StatusCode)
	}
	out, err := os.Create(outPath)
	if err != nil {
		return nil, &ExtractError{Code: "WRITE_ERROR", Message: "Could not create the output file: " + err.Error()}
	}
	defer out.Close()
	written, err := io.Copy(out, resp.Body)
	if err != nil {
		os.Remove(outPath)
		return nil, &ExtractError{Code: "DOWNLOAD_INTERRUPTED", Retryable: true,
			Message: "The media download was interrupted: " + err.Error(),
			Details: map[string]any{"bytesWritten": written}}
	}
	return &DownloadResult{Path: outPath, Itag: chosen.Itag, MimeType: chosen.MimeType, BytesWritten: written}, nil
}
