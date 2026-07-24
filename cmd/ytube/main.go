// Command ytube is the JSON CLI consumed by the TypeScript MCP layer (YouTube Client).
//
// Every command prints exactly one JSON object to stdout:
//
//	{"ok":true,"data":...}
//	{"ok":false,"error":{"code":...,"message":...,"details":...,"retryable":...}}
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"strconv"
	"strings"
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
		fail(&youtube.ExtractError{Code: "USAGE", Message: usage()})
	}
	command := os.Args[1]
	fs := flag.NewFlagSet(command, flag.ContinueOnError)
	urlFlag := fs.String("url", "", "YouTube URL or ID")
	queryFlag := fs.String("query", "", "search / transcript-search query")
	langFlag := fs.String("lang", "", "caption language code")
	mergeFlag := fs.String("merge", "auto", "merge ASR mid-phrase cues: auto|true|false")
	formatFlag := fs.String("format", "srt", "subtitle format: srt|vtt|ass|json|text")
	itagFlag := fs.Int("itag", 0, "format itag")
	outFlag := fs.String("out", "", "output file path")
	limitFlag := fs.Int("limit", 0, "max items to return")
	sortFlag := fs.String("sort", "top", "comments sort: top|newest")
	startFlag := fs.String("start", "", "clip start (seconds or M:SS)")
	endFlag := fs.String("end", "", "clip end (seconds or M:SS)")
	cookiesFlag := fs.String("cookies", "", "path to Netscape cookies.txt")
	apiKeyFlag := fs.String("api-key", "", "optional YouTube Data API v3 key (or YOUTUBE_API_KEY)")
	chunkFlag := fs.Int("chunk-chars", 800, "target characters per RAG chunk (videopack)")
	cursorFlag := fs.String("cursor", "", "resume position from a previous call's nextCursor")
	maxCharsFlag := fs.Int("max-chars", 0, "max transcript characters per page (0 = whole transcript)")
	topKFlag := fs.Int("top-k", 5, "passages to return (ask)")
	repliesFlag := fs.Int("replies", 0, "expand replies for up to N comment threads")
	includeChunksFlag := fs.Bool("include-chunks", false, "embed full chunk text in batch packs")
	skipSponsorsFlag := fs.Bool("skip-sponsors", false, "drop SponsorBlock-flagged ranges (needs YTUBE_SPONSORBLOCK=1)")
	timeoutFlag := fs.Duration("timeout", 30*time.Second, "per-request timeout")
	if err := fs.Parse(os.Args[2:]); err != nil {
		fail(&youtube.ExtractError{Code: "USAGE", Message: err.Error()})
	}

	client := youtube.NewClient(*timeoutFlag)
	cookies := *cookiesFlag
	if cookies == "" {
		cookies = os.Getenv("YTUBE_COOKIES")
	}
	if cookies != "" {
		if err := client.WithCookies(cookies); err != nil {
			fail(err)
		}
	}
	apiKey := *apiKeyFlag
	if apiKey == "" {
		apiKey = os.Getenv("YOUTUBE_API_KEY")
	}
	if apiKey != "" {
		client.WithAPIKey(apiKey)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()

	needsURL := map[string]bool{
		"info": true, "transcript": true, "transcript-clip": true, "transcript-search": true,
		"captions": true, "chapters": true, "formats": true, "thumbnails": true, "download": true,
		"subtitles": true, "related": true, "comments": true, "heatmap": true, "storyboards": true,
		"manifests": true, "playlist": true, "channel": true, "videopack": true,
		"ask": true, "sponsors": true, "packbatch": true,
	}
	if needsURL[command] && *urlFlag == "" {
		fail(&youtube.ExtractError{Code: "USAGE", Message: "The --url flag is required for " + command})
	}

	switch command {
	case "info":
		result, err := client.Info(ctx, *urlFlag)
		if err != nil {
			fail(err)
		}
		emit(true, result, nil)
	case "transcript":
		result, err := client.TranscriptWithOptions(ctx, *urlFlag, transcriptOpts(*langFlag, *mergeFlag))
		if err != nil {
			fail(err)
		}
		emit(true, youtube.PageTranscript(result, intCursor(*cursorFlag), *maxCharsFlag), nil)
	case "transcript-clip":
		start, end, err := parseRange(*startFlag, *endFlag)
		if err != nil {
			fail(err)
		}
		result, err := client.TranscriptClip(ctx, *urlFlag, *langFlag, start, end)
		if err != nil {
			fail(err)
		}
		emit(true, result, nil)
	case "transcript-search":
		if *queryFlag == "" {
			fail(&youtube.ExtractError{Code: "USAGE", Message: "--query is required for transcript-search"})
		}
		result, err := client.SearchTranscript(ctx, *urlFlag, *langFlag, *queryFlag, 1)
		if err != nil {
			fail(err)
		}
		emit(true, result, nil)
	case "subtitles":
		result, err := client.ExportSubtitles(ctx, *urlFlag, *langFlag, *formatFlag, *outFlag)
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
		result, err := client.Chapters(ctx, *urlFlag)
		if err != nil {
			fail(err)
		}
		emit(true, result, nil)
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
			fail(&youtube.ExtractError{Code: "USAGE", Message: "The --out flag is required for download"})
		}
		result, err := client.Download(ctx, *urlFlag, *itagFlag, *outFlag)
		if err != nil {
			fail(err)
		}
		emit(true, result, nil)
	case "related":
		result, err := client.Related(ctx, *urlFlag)
		if err != nil {
			fail(err)
		}
		emit(true, result, nil)
	case "comments":
		result, err := client.CommentsWithOptions(ctx, *urlFlag, youtube.CommentsOptions{
			Limit: *limitFlag, Sort: *sortFlag, Cursor: *cursorFlag, Replies: *repliesFlag,
		})
		if err != nil {
			fail(err)
		}
		emit(true, result, nil)
	case "heatmap":
		result, err := client.Heatmap(ctx, *urlFlag)
		if err != nil {
			fail(err)
		}
		emit(true, result, nil)
	case "storyboards":
		result, err := client.Storyboards(ctx, *urlFlag)
		if err != nil {
			fail(err)
		}
		emit(true, result, nil)
	case "manifests":
		result, err := client.Manifests(ctx, *urlFlag)
		if err != nil {
			fail(err)
		}
		emit(true, result, nil)
	case "playlist":
		result, err := client.Playlist(ctx, *urlFlag, *limitFlag)
		if err != nil {
			fail(err)
		}
		emit(true, result, nil)
	case "channel":
		result, err := client.ChannelPreferAPI(ctx, *urlFlag, *limitFlag)
		if err != nil {
			fail(err)
		}
		emit(true, result, nil)
	case "search":
		if *queryFlag == "" {
			fail(&youtube.ExtractError{Code: "USAGE", Message: "--query is required for search"})
		}
		result, err := client.SearchPreferAPI(ctx, *queryFlag, *limitFlag)
		if err != nil {
			fail(err)
		}
		emit(true, result, nil)
	case "videopack":
		result, err := client.VideoPackWithOptions(ctx, *urlFlag, youtube.PackOptions{
			Lang: *langFlag, ChunkChars: *chunkFlag, SkipSponsors: *skipSponsorsFlag,
		})
		if err != nil {
			fail(err)
		}
		emit(true, result, nil)
	case "packbatch":
		result, err := client.BatchPackFor(ctx, *urlFlag, youtube.BatchOptions{
			Lang: *langFlag, ChunkChars: *chunkFlag, Limit: *limitFlag,
			Cursor: intCursor(*cursorFlag), IncludeChunks: *includeChunksFlag,
			SkipSponsors: *skipSponsorsFlag,
		})
		if err != nil {
			fail(err)
		}
		emit(true, result, nil)
	case "ask":
		if *queryFlag == "" {
			fail(&youtube.ExtractError{Code: "USAGE", Message: "--query is required for ask"})
		}
		result, err := client.AskVideo(ctx, *urlFlag, *langFlag, *queryFlag, *topKFlag, *chunkFlag)
		if err != nil {
			fail(err)
		}
		emit(true, result, nil)
	case "sponsors":
		segments, err := client.SponsorSegments(ctx, *urlFlag)
		if err != nil {
			fail(err)
		}
		emit(true, map[string]any{"segments": segments, "count": len(segments)}, nil)
	default:
		fail(&youtube.ExtractError{Code: "USAGE", Message: fmt.Sprintf("Unknown command %q. %s", command, usage())})
	}
}

func usage() string {
	return "Usage: ytube <info|transcript|transcript-clip|transcript-search|subtitles|captions|chapters|formats|thumbnails|download|related|comments|heatmap|storyboards|manifests|playlist|channel|search|videopack|packbatch|ask|sponsors> [options]"
}

// intCursor reads a numeric cursor; non-numeric cursors belong to token-based
// commands (comments) and are ignored here.
func intCursor(s string) int {
	n, err := strconv.Atoi(strings.TrimSpace(s))
	if err != nil || n < 0 {
		return 0
	}
	return n
}

func parseRange(startS, endS string) (float64, float64, error) {
	var start, end float64
	var err error
	if startS != "" {
		if start, err = parseTimeArg(startS); err != nil {
			return 0, 0, err
		}
	}
	if endS != "" {
		if end, err = parseTimeArg(endS); err != nil {
			return 0, 0, err
		}
	}
	return start, end, nil
}

func parseTimeArg(s string) (float64, error) {
	if strings.Contains(s, ":") {
		return youtube.ParseTimestamp(s)
	}
	var f float64
	_, err := fmt.Sscanf(s, "%f", &f)
	if err != nil {
		return 0, &youtube.ExtractError{Code: "INVALID_TIMESTAMP", Message: "Could not parse time value: " + s}
	}
	return f, nil
}

func transcriptOpts(lang, merge string) youtube.TranscriptOptions {
	opts := youtube.TranscriptOptions{Lang: lang}
	switch strings.ToLower(strings.TrimSpace(merge)) {
	case "true", "1", "yes", "on":
		v := true
		opts.Merge = &v
	case "false", "0", "no", "off":
		v := false
		opts.Merge = &v
	}
	return opts
}
