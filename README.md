# Ground Truth

A question-answering assistant that only answers from the documents you give it, and says so when it can't.

You upload PDFs or paste in text, then ask questions. In the default closed-book mode, every answer either cites the document it came from or is refused with a note on what the documents are missing. Every question and answer is kept in an audit log you can download as JSON.

## Why it exists

Most document chatbots quietly fill gaps with the model's general knowledge, so you can't tell which parts of an answer came from your files. Ground Truth makes that visible: an answer is either grounded in your documents, with citations, or it is refused.

## What it does

- **Builds a session library.** Add PDFs and text files (up to 8 MB each), or paste text in as a note. Remove any document at any time.
- **Closed-book mode (default).** The model is told to use only the session documents. It must reply in a fixed JSON format with `grounded: true` and a list of citations, or `grounded: false` and an explanation. Each answer is stamped Grounded, Not in corpus, or Unverified (when the reply breaks the format).
- **Open mode.** Prefers your documents but may also use web search and general knowledge, and must list its sources at the end.
- **Keeps the conversation.** Earlier turns are sent along so follow-up questions make sense.
- **Audit log.** Every exchange is recorded with its mode, verdict and citations, and can be exported as a JSON file.

## How it works

1. Documents are read in the browser. PDFs are sent to the model as document attachments; text files are wrapped in labeled `=== DOCUMENT ===` blocks.
2. Each question goes to Claude through the Anthropic Messages API, along with the mode's rules and the documents.
3. In closed-book mode the reply is parsed as JSON. If it can't be parsed, the answer is shown but marked Unverified rather than trusted.
4. Open mode turns on the web search tool.

## Run it

The whole app is one React component, `ground-truth.jsx`.

It was built to run as a Claude artifact on claude.ai, where requests to the Anthropic API are handled for you. Outside claude.ai it needs a small backend that adds your API key to each request, because the component calls the API directly and does not handle keys.

## Tech stack

React (hooks), the Anthropic Messages API with PDF document input and the web search tool, and plain CSS-in-JS. No other dependencies.

## Limits

- Grounding is enforced by instructions and a strict output format, not by checking each citation against the source text. A citation shows where the model says it found the answer.
- Documents live only in the browser session. Nothing is saved between visits except the audit log you export.
