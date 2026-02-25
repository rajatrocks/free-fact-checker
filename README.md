# Free Fact Checker

A free Chrome extension that lets you highlight any text on a webpage and instantly fact-check it using Google Search and Gemini.

*Click the image below for a preview video*
[![Free Fact Checker demo video](https://img.youtube.com/vi/Ed7sOlvik0E/maxresdefault.jpg)](https://www.youtube.com/watch?v=Ed7sOlvik0E)

## How It Works

1. **Highlight Text** — Select any statement on any webpage: news articles, social media, PDFs, anywhere you can highlight text. Then use the right-click menu or press the toolbar icon to trigger a fact check.
2. **Google Search Grounding** — Your text is sent to Google Gemini, which finds real data about it using Google Search through a process called grounding.
3. **Get Cited Results** — You get a fact-check with citations and sources. You will never get an AI's opinion — only answers grounded in Google Search.

## Features

- **Works Everywhere** — Facebook, X (Twitter), YouTube, Instagram, Bluesky, Reddit, major news sites, PDFs, Google Docs and Google Slides — any page where you can highlight text.
- **Grounded in Search** — Results come from Google Search, not AI opinion. If no data can be found, it will tell you instead of making something up.
- **100% Free** — The extension is free. Google lets you make 20 grounding requests per day on a free Gemini API Key.
- **No Tracking** — Your queries go directly from your browser to Google's API using your own key. There is no tracking or analytics.
- **No Login Required** — Use it immediately after installing and adding your API key.
- **Check Your Writing** — Highlight any text in your own writing and get instant fact-checks to ensure accuracy.
- **Source Code Available** — The source code is available for you to review, edit, and install yourself.

## Install from the Chrome Web Store

Add Free Fact Checker from the [Chrome Web Store](https://chromewebstore.google.com/detail/ehfhjhljagpmgphmahlggfeohhcdeecf). Works in Chrome, Edge, Brave, Vivaldi, Arc, and Opera.

## Install from GitHub

### Quick install (no build required)

Download [`release.zip`](https://github.com/rajatrocks/free-fact-checker/raw/main/release.zip) from this repo, then:

1. **Unzip** `release.zip` — this creates a folder with the ready-to-load extension
2. **Load into your browser**
   - Open `chrome://extensions` (or the equivalent in your Chromium browser)
   - Enable **Developer mode** (toggle in the top right)
   - Click **Load unpacked**
   - Select the unzipped folder
3. **Get a free Gemini API Key** — Go to [Google AI Studio](https://aistudio.google.com/apikey) and create a free API key (takes about a minute)
4. **Add your key** — Click the Free Fact Checker extension icon, open Settings, and paste in your API key

### Build from source

If you'd prefer to build the extension yourself:

1. **Clone and build**
   ```bash
   git clone https://github.com/rajatrocks/free-fact-checker.git
   cd free-fact-checker
   npm install
   npm run build
   ```

2. **Load into your browser** — Follow steps 2–4 above, selecting the `dist/` folder

## FAQ

**Is it really free?**
Yes. The extension is free and you can get a free Gemini API Key from Google. Google lets you make 20 grounding requests per day on the free plan. If you want more, you'll need to set up billing in [AI Studio](https://aistudio.google.com/apikey).

**Why do I need my own API key?**
If we ran your requests through our server, Google would charge us for every request. By using your own free API key, everyone gets to use the Free Fact Checker for free without limits or subscriptions.

**Can I trust this?**
The Free Fact Checker uses Google Search to find information. It will never give you an AI's opinion — only search-grounded answers. If Google Search can't find information about a claim, it will tell you that instead of making something up.

**What browsers does it work in?**
All Chromium-based browsers including Chrome, Edge, Brave, Vivaldi, Arc, and Opera. It does not work on mobile browsers.

**Is my usage being tracked?**
No. Your queries go directly from your browser to Google's API using your own key. There is no tracking, analytics, or telemetry of any kind.

**What countries does it work in?**
Any country where you can get a Gemini API Key. Free keys are not available in all countries — check [Google's availability page](https://ai.google.dev/gemini-api/docs/available-regions) for details.

**Who made this?**
The Free Fact Checker was originally created as an Agent in [Ask Steve](https://www.asksteve.to). We found it so useful that we decided to make it available as a standalone extension.

See more details at https://www.freefactchecker.com
