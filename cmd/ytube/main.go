// Command ytube is the JSON CLI consumed by the TypeScript MCP layer.
//
// Every command prints exactly one JSON object to stdout:
//
//	{"ok":true,"data":...}
//	{"ok":false,"error":{"code":...,"message":...,"details":...,"retryable":...}}
//
// Usage:
//
//	ytube info       --url <urlOrId>
//	ytube transcript --url <urlOrId> [--lang en]
//	ytube captions   --url <urlOrId>
//	ytube chapters   --url <urlOrId>
//	ytube formats    --url <urlOrId>
//	ytube thumbnails --url <urlOrId>
//	ytube download   --url <urlOrId> [--itag N] --out <path>
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"time"

	"github.com/ak3ilb/youtube/internal/youtube"
)

type errorPayload struct {
	Code      string         `json:"code"`
	Message   string         `json:"message"`
	Details   map[string]any `json:"details,omitempty"`
	Retryable bool           `json:"retryable"`
}

func emit(ok bool, data any, extractErr *youtube.ExtractError) {
	out := map[string]any{"ok": ok}
	if ok {
		out["data"] = data
	} else {
		out["error"] = errorPayload{
			Code: extractErr.Code, Message: extractErr.Message,
			Details: extractErr.Details, Retryable: extractErr.Retryable,
		}
	}
	enc := json.NewEncoder(os.Stdout)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(out)
}

func fail(err error) {
	var ee *youtube.ExtractError
	if !errors.As(err, &ee) {
		ee = &youtube.ExtractError{Code: "INTERNAL_ERROR", Message: err.Error()}
	}
	emit(false, nil, ee)
	os.Exit(1)
}

func main() {
	if len(os.Args) < 2 {
		fail(&youtube.ExtractError{Code: "USAGE",
			Message: "Usage: ytube <info|transcript|captions|chapters|formats|thumbnails|download> --url <urlOrId> [options]"})
	}
	command := os.Args[1]
	fs := flag.NewFlagSet(command, flag.ContinueOnError)
	urlFlag := fs.String("url", "", "YouTube video URL or 11-character ID")
	langFlag := fs.String("lang", "", "caption language code (transcript only)")
	itagFlag := fs.Int("itag", 0, "format itag (download only)")
	outFlag := fs.String("out", "", "output file path (download only)")
	timeoutFlag := fs.Duration("timeout", 30*time.Second, "per-request timeout")
	if err := fs.Parse(os.Args[2:]); err != nil {
		fail(&youtube.ExtractError{Code: "USAGE", Message: err.Error()})
	}
	if *urlFlag == "" {
		fail(&youtube.ExtractError{Code: "USAGE", Message: "The --url flag is required (YouTube URL or 11-character video ID)"})
	}

	client := youtube.NewClient(*timeoutFlag)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()

	switch command {
	case "info":
		result, err := client.Info(ctx, *urlFlag)
		if err != nil {
			fail(err)
		}
		emit(true, result, nil)
	case "transcript":
		result, err := client.Transcript(ctx, *urlFlag, *langFlag)
		if err != nil {
			fail(err)
		}
		emit(true, result, nil)
	case "captions":
		result, err := client.ListCaptions(ctx, *urlFlag)
		if err != nil {
			fail(err)
		}
		emit(true, map[string]any{"tracks": result, "count": len(result)}, nil)
	case "chapters":
		chapters, info, err := client.Chapters(ctx, *urlFlag)
		if err != nil {
			fail(err)
		}
		emit(true, map[string]any{
			"videoId": info.ID, "title": info.Title,
			"chapters": chapters, "count": len(chapters),
			"hasChapters": len(chapters) > 0,
		}, nil)
	case "formats":
		formats, clientName, err := client.Formats(ctx, *urlFlag)
		if err != nil {
			fail(err)
		}
		emit(true, map[string]any{"formats": formats, "count": len(formats), "innertubeClient": clientName}, nil)
	case "thumbnails":
		info, err := client.Info(ctx, *urlFlag)
		if err != nil {
			fail(err)
		}
		emit(true, map[string]any{"videoId": info.ID, "thumbnails": info.Thumbnails}, nil)
	case "download":
		if *outFlag == "" {
			fail(&youtube.ExtractError{Code: "USAGE", Message: "The --out flag is required for download (destination file path)"})
		}
		result, err := client.Download(ctx, *urlFlag, *itagFlag, *outFlag)
		if err != nil {
			fail(err)
		}
		emit(true, result, nil)
	default:
		fail(&youtube.ExtractError{Code: "USAGE",
			Message: fmt.Sprintf("Unknown command %q; expected info, transcript, captions, chapters, formats, thumbnails or download", command)})
	}
}
