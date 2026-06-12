#!/usr/bin/env python3
"""Generate the claudeseek README banner with gpt-image-2.

Same pencil-sketch pipeline and house style as D:/Company/.banner-gen
(gen_banners.py) so claudeseek's banner sits in the owner's GitHub banner family
(see refs: weiping-whale.png, kbuilt-girl.png). Subject expresses the
Claude x DeepSeek fusion: warm terracotta (Claude) + deep-sea blue (DeepSeek).

IMPORTANT (owner rule, 2026-06-12): image generation must use the OFFICIAL
OpenAI endpoint only — never a relay/proxy. Use a genuine OPENAI_API_KEY against
api.openai.com (the default). Do not point OPENAI_BASE_URL at a relay.

Usage:
  set a genuine OPENAI_API_KEY, then:  python scripts/gen-banner.py
  optional: BANNER_IMAGE_MODEL (default gpt-image-2).
"""
import base64
import os
import sys

from openai import OpenAI
from PIL import Image

OUT = os.path.join(os.path.dirname(__file__), "..", "assets", "banner.png")
TITLE = "claudeseek"

STYLE = """
Use case: GitHub project README banner.
Composition: very wide horizontal banner, similar aspect ratio to 1983x793.
Style reference: match the owner's existing GitHub banner family: anime-inspired
little-girl pencil sketch, light graphite linework, soft gray shading, clean
white or very pale graph-paper background, technical desk/workbench setting,
small floating information-diagram elements, sparse accent marks. Do not use a
warm yellow storybook paper look, photorealism, 3D, glossy UI, or oversaturated
colors.
Mood: open-source, trustworthy, technical but charming.
Text: include only a clean hand-sketched project title "{title}" if it can be
legible; no other large text, no fake captions, no watermark.
Output: polished bitmap banner, pencil drawing, high-resolution, no border.
""".strip()

SUBJECT = """
Subject: a cute anime-style little girl drawn in pencil, sitting confidently at
a tidy desk, working in a terminal on her laptop. A small friendly whale mascot
(a nod to the DeepSeek engine) rests beside her keyboard. The scene reads as a
coding AI agent at work.
Diagram elements: a terminal window streaming code token by token; floating
tool-call cards around it labelled with tiny icons — a file (read/edit), a shell
prompt ">_", a magnifier (search); a small shield with a check mark
(permission approval); a circular arrow loop linking "think -> act -> observe"
(the agent loop); a tiny two-tone gem split into a warm half and a cool-blue
half (the Claude x DeepSeek fusion). Keep labels tiny and diagram-like.
Accent color: mostly grayscale pencil; sparse warm terracotta accents (Claude)
and deep-sea blue accents (DeepSeek), e.g. the gem, the loop arrow, and one
streaming line.
""".strip()


def save_wide_banner(b64, out):
    os.makedirs(os.path.dirname(out), exist_ok=True)
    tmp = out + ".raw.png"
    with open(tmp, "wb") as f:
        f.write(base64.b64decode(b64))
    im = Image.open(tmp).convert("RGB")
    target = 1983 / 793
    w, h = im.size
    ratio = w / h
    if ratio > target:
        nw = int(h * target)
        left = (w - nw) // 2
        im = im.crop((left, 0, left + nw, h))
    else:
        nh = int(w / target)
        top = max(0, (h - nh) // 2)
        im = im.crop((0, top, w, top + nh))
    im = im.resize((1983, 793), Image.Resampling.LANCZOS)
    im.save(out, optimize=True)
    os.remove(tmp)


def resolve_official_credentials():
    """Return (api_key, base_url) for the OFFICIAL OpenAI endpoint, or raise.

    Owner rule: image generation must hit api.openai.com directly — never a
    relay/proxy. This machine sets a global OPENAI_BASE_URL + OPENAI_API_KEY that
    point at a relay (for chat), so we must NOT blindly inherit them here:

      1. OPENAI_API_KEY_OFFICIAL (if set) is always treated as a genuine
         api.openai.com key and wins — it sidesteps the relay env entirely.
      2. Otherwise OPENAI_API_KEY is accepted ONLY when OPENAI_BASE_URL is unset
         or already official (api.openai.com). A relay base_url is refused.
    """
    def is_official(base):
        if not base:
            return True
        host = base.split("//", 1)[-1].split("/", 1)[0].lower()
        return host == "api.openai.com" or host.endswith(".api.openai.com")

    official_key = os.environ.get("OPENAI_API_KEY_OFFICIAL")
    if official_key:
        return official_key, "https://api.openai.com/v1"

    key = os.environ.get("OPENAI_API_KEY")
    base = os.environ.get("OPENAI_BASE_URL")
    if not key:
        raise RuntimeError(
            "No official key. Set OPENAI_API_KEY_OFFICIAL to a genuine "
            "api.openai.com key (image generation must not be proxied)."
        )
    if not is_official(base):
        raise RuntimeError(
            f"Refusing to generate via non-official endpoint '{base}'. "
            "Owner rule: gpt-image must hit api.openai.com only. Set "
            "OPENAI_API_KEY_OFFICIAL (a genuine OpenAI key) to proceed; the "
            "relay OPENAI_BASE_URL/OPENAI_API_KEY are ignored for images."
        )
    return key, base or "https://api.openai.com/v1"


def main():
    try:
        key, base_url = resolve_official_credentials()
    except RuntimeError as e:
        print(str(e), file=sys.stderr)
        return 1
    # Official OpenAI endpoint only. No relay, no User-Agent spoof.
    client = OpenAI(api_key=key, base_url=base_url)
    model = os.environ.get("BANNER_IMAGE_MODEL", "gpt-image-2")
    prompt = (
        f"Create a wide README banner illustration for an open-source AI coding "
        f"agent named {TITLE}.\n\n" + SUBJECT + "\n" + STYLE.format(title=TITLE)
    )
    attempts = [
        dict(stream=True, size="1536x1024", quality="high"),
        dict(stream=True, size="1536x1024", quality="medium"),
        dict(stream=False, size="1024x1024", quality="medium"),
    ]
    b64 = None
    last_err = None
    for i, opts in enumerate(attempts, 1):
        print(f"try {i}/{len(attempts)} {opts} ...", flush=True)
        try:
            if opts["stream"]:
                stream = client.images.generate(
                    model=model, prompt=prompt, size=opts["size"],
                    quality=opts["quality"], n=1, stream=True,
                )
                for event in stream:
                    et = getattr(event, "type", "")
                    if et == "image_generation.completed":
                        b64 = event.b64_json
                    elif et == "image_generation.partial_image":
                        b64 = event.b64_json
            else:
                resp = client.images.generate(
                    model=model, prompt=prompt, size=opts["size"],
                    quality=opts["quality"], n=1,
                )
                b64 = resp.data[0].b64_json
            if b64:
                break
        except Exception as e:  # noqa: BLE001
            last_err = e
            print(f"failed: {str(e)[:200]}", file=sys.stderr, flush=True)
    if not b64:
        print(f"no image produced: {last_err}", file=sys.stderr)
        return 1
    save_wide_banner(b64, OUT)
    print(f"saved -> {os.path.abspath(OUT)} ({os.path.getsize(OUT)//1024}KB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
