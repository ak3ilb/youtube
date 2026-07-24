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
			Itag: f.Itag, MimeType: f.MimeType, Quality: f.Quality, QualityLabel: f.QualityLabel,
			AudioQuality: f.AudioQuality, Bitrate: f.Bitrate, ContentLength: length,
			HasAudio:  strings.HasPrefix(mime, "audio/") || f.AudioQuality != "",
			HasVideo:  strings.HasPrefix(mime, "video/"),
			DirectURL: f.URL != "", StreamURL: f.URL,
		})
	}
	sort.SliceStable(formats, func(i, j int) bool { return formats[i].Itag < formats[j].Itag })
	return formats
}

// Formats lists stream formats.
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
// Resumes from an existing .part file using HTTP Range when possible.
func (c *Client) Download(ctx context.Context, input string, itag int, outPath string) (*DownloadResult, error) {
	formats, _, err := c.Formats(ctx, input)
	if err != nil {
		return nil, err
	}
	chosen, err := pickFormat(formats, itag)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Dir(outPath), 0o755); err != nil {
		return nil, &ExtractError{Code: "WRITE_ERROR", Message: "Could not create the output directory: " + err.Error()}
	}
	partPath := outPath + ".part"
	var offset int64
	if st, err := os.Stat(partPath); err == nil {
		offset = st.Size()
	}

	var written int64
	for attempt := 0; attempt < maxRetries; attempt++ {
		n, done, err := c.downloadOnce(ctx, chosen, partPath, offset)
		written = n
		if err == nil && done {
			if err := os.Rename(partPath, outPath); err != nil {
				return nil, &ExtractError{Code: "WRITE_ERROR", Message: "Could not finalize download: " + err.Error()}
			}
			return &DownloadResult{Path: outPath, Itag: chosen.Itag, MimeType: chosen.MimeType, BytesWritten: written}, nil
		}
		if err != nil && attempt == maxRetries-1 {
			return nil, err
		}
		if st, e := os.Stat(partPath); e == nil {
			offset = st.Size()
		}
	}
	return nil, &ExtractError{Code: "DOWNLOAD_INTERRUPTED", Retryable: true,
		Message: "The media download failed after retries", Details: map[string]any{"bytesWritten": written}}
}

func pickFormat(formats []Format, itag int) (*Format, error) {
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
	return chosen, nil
}

func (c *Client) downloadOnce(ctx context.Context, chosen *Format, partPath string, offset int64) (written int64, done bool, err error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, chosen.StreamURL, nil)
	if err != nil {
		return 0, false, err
	}
	req.Header.Set("User-Agent", androidUserAgent)
	if offset > 0 {
		req.Header.Set("Range", fmt.Sprintf("bytes=%d-", offset))
	}
	mediaClient := &http.Client{}
	resp, err := mediaClient.Do(req)
	if err != nil {
		return offset, false, classifyNetworkError(err)
	}
	defer resp.Body.Close()

	if offset > 0 && resp.StatusCode == http.StatusOK {
		// Server ignored Range; restart from scratch.
		offset = 0
		_ = os.Remove(partPath)
	}
	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusPartialContent {
		return offset, false, httpStatusError(resp.StatusCode)
	}

	var out *os.File
	if offset > 0 {
		out, err = os.OpenFile(partPath, os.O_APPEND|os.O_WRONLY, 0o644)
	} else {
		out, err = os.Create(partPath)
	}
	if err != nil {
		return offset, false, &ExtractError{Code: "WRITE_ERROR", Message: "Could not create the output file: " + err.Error()}
	}
	defer out.Close()

	n, err := io.Copy(out, resp.Body)
	written = offset + n
	if err != nil {
		return written, false, &ExtractError{Code: "DOWNLOAD_INTERRUPTED", Retryable: true,
			Message: "The media download was interrupted: " + err.Error(),
			Details: map[string]any{"bytesWritten": written}}
	}
	if chosen.ContentLength > 0 && uint64(written) < chosen.ContentLength && resp.StatusCode == http.StatusPartialContent {
		return written, false, &ExtractError{Code: "INCOMPLETE_DOWNLOAD", Retryable: true,
			Message: fmt.Sprintf("Downloaded %d of %d bytes", written, chosen.ContentLength),
			Details: map[string]any{"bytesWritten": written, "contentLength": chosen.ContentLength}}
	}
	return written, true, nil
}
