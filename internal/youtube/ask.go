package youtube

import (
	"context"
	"fmt"
	"math"
	"sort"
	"strings"
	"unicode"
)

// Passage is one retrieved transcript window with its relevance score.
type Passage struct {
	Chunk RAGChunk `json:"chunk"`
	Score float64  `json:"score"`
}

// AskResult answers a question with citation-ready passages instead of the
// whole transcript, so an agent can stay inside its context window.
type AskResult struct {
	VideoID   string    `json:"videoId"`
	Title     string    `json:"title"`
	URL       string    `json:"url"`
	Question  string    `json:"question"`
	Language  string    `json:"language,omitempty"`
	Matched   int       `json:"matched"`
	Passages  []Passage `json:"passages"`
	Context   string    `json:"context"`
	HowToCite string    `json:"howToCite"`
}

func tokenize(s string) []string {
	fields := strings.FieldsFunc(strings.ToLower(s), func(r rune) bool {
		return !unicode.IsLetter(r) && !unicode.IsDigit(r)
	})
	out := make([]string, 0, len(fields))
	for _, f := range fields {
		if len(f) > 1 && !stopWords[f] {
			out = append(out, f)
		}
	}
	return out
}

var stopWords = map[string]bool{
	"the": true, "and": true, "for": true, "are": true, "but": true, "not": true,
	"you": true, "your": true, "with": true, "that": true, "this": true, "was": true,
	"what": true, "who": true, "how": true, "why": true, "when": true, "does": true,
	"did": true, "can": true, "about": true, "from": true, "they": true, "them": true,
	"has": true, "have": true, "were": true, "into": true, "there": true, "their": true,
}

// RankPassages scores chunks against a question with BM25 plus a bonus for
// exact phrase hits, then returns the best topK.
func RankPassages(chunks []RAGChunk, question string, topK int) []Passage {
	terms := tokenize(question)
	if len(terms) == 0 || len(chunks) == 0 {
		return nil
	}
	if topK <= 0 {
		topK = 5
	}

	const k1, b = 1.5, 0.75
	docTokens := make([][]string, len(chunks))
	var totalLen int
	docFreq := map[string]int{}
	for i, ch := range chunks {
		docTokens[i] = tokenize(ch.Text)
		totalLen += len(docTokens[i])
		seen := map[string]bool{}
		for _, t := range docTokens[i] {
			if !seen[t] {
				seen[t] = true
				docFreq[t]++
			}
		}
	}
	avgLen := float64(totalLen) / float64(len(chunks))
	if avgLen == 0 {
		avgLen = 1
	}
	phrase := strings.ToLower(strings.TrimSpace(question))

	scored := make([]Passage, 0, len(chunks))
	for i, ch := range chunks {
		termFreq := map[string]int{}
		for _, t := range docTokens[i] {
			termFreq[t]++
		}
		var score float64
		for _, term := range terms {
			tf := float64(termFreq[term])
			if tf == 0 {
				continue
			}
			df := float64(docFreq[term])
			idf := math.Log(1 + (float64(len(chunks))-df+0.5)/(df+0.5))
			docLen := float64(len(docTokens[i]))
			score += idf * (tf * (k1 + 1)) / (tf + k1*(1-b+b*docLen/avgLen))
		}
		if score > 0 && strings.Contains(strings.ToLower(ch.Text), phrase) {
			score *= 1.5
		}
		if score > 0 {
			scored = append(scored, Passage{Chunk: ch, Score: score})
		}
	}
	sort.SliceStable(scored, func(i, j int) bool {
		if scored[i].Score == scored[j].Score {
			return scored[i].Chunk.Start < scored[j].Chunk.Start
		}
		return scored[i].Score > scored[j].Score
	})
	if len(scored) > topK {
		scored = scored[:topK]
	}
	return scored
}

func renderPassageContext(info *VideoInfo, passages []Passage) string {
	var b strings.Builder
	fmt.Fprintf(&b, "# %s\n\n%s\n\n", info.Title, info.URL)
	if len(passages) == 0 {
		b.WriteString("No transcript passages matched the question.\n")
		return b.String()
	}
	b.WriteString("## Relevant passages\n\n")
	for _, p := range passages {
		fmt.Fprintf(&b, "### %s (%s)\n\n%s\n\n", p.Chunk.Citation, p.Chunk.URL, p.Chunk.Text)
	}
	return b.String()
}

// AskVideo retrieves the transcript passages most relevant to a question.
func (c *Client) AskVideo(ctx context.Context, input, lang, question string, topK, chunkChars int) (*AskResult, error) {
	question = strings.TrimSpace(question)
	if question == "" {
		return nil, &ExtractError{Code: "USAGE", Message: "a question is required for ask"}
	}
	if chunkChars <= 0 {
		chunkChars = 600
	}
	pack, err := c.VideoPackWithOptions(ctx, input, PackOptions{Lang: lang, ChunkChars: chunkChars})
	if err != nil {
		return nil, err
	}
	passages := RankPassages(pack.Chunks, question, topK)
	return &AskResult{
		VideoID: pack.Video.ID, Title: pack.Video.Title, URL: pack.Video.URL,
		Question: question, Language: pack.Language,
		Matched: len(passages), Passages: passages,
		Context:   renderPassageContext(pack.Video, passages),
		HowToCite: "Quote passages with their citation timestamp and link chunk.url so readers can jump to that moment.",
	}, nil
}
