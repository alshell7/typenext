"""Small public-data FIM preparation helpers; no model framework or private notes."""
from __future__ import annotations

import hashlib
import random
import re
import urllib.request

BOOKS = {
    "train": {
        "title": "Pride and Prejudice",
        "author": "Jane Austen",
        "url": "https://www.gutenberg.org/cache/epub/1342/pg1342.txt",
        "sha256": "3f6bb9d6f78e0293b56acd4714dd68cb7d6d1d293402031ce9d5a216bcaf9d75",
        "bytes": 772386,
    },
    "validation": {
        "title": "Alice's Adventures in Wonderland",
        "author": "Lewis Carroll",
        "url": "https://www.gutenberg.org/cache/epub/11/pg11.txt",
        "sha256": "01b38ea4c710a84bc18d0bd41271a5a1a92b94e97b2812f4dece97d4a694725e",
        "bytes": 174311,
    },
}
FIM_TOKENS = ["<|fim_prefix|>", "<|fim_suffix|>", "<|fim_middle|>", "<|fim_end|>"]


def verified_body(raw: bytes, manifest: dict) -> str:
    """Verify source bytes before stripping Gutenberg headers and license appendix."""
    if len(raw) != manifest["bytes"] or hashlib.sha256(raw).hexdigest() != manifest["sha256"]:
        raise ValueError("Public dataset bytes changed. Review the source before updating its pin.")
    text = raw.decode("utf-8-sig").replace("\r\n", "\n")
    start = re.search(r"^\*\*\* START OF (?:THE|THIS) PROJECT GUTENBERG EBOOK .*?\*\*\*\s*$", text, re.M)
    end = re.search(r"^\*\*\* END OF (?:THE|THIS) PROJECT GUTENBERG EBOOK .*?\*\*\*\s*$", text, re.M)
    if not start or not end or start.end() >= end.start():
        raise ValueError("Missing Gutenberg source boundaries; refusing to train on header/license text.")
    return text[start.end():end.start()].strip()


def download_book(manifest: dict) -> str:
    request = urllib.request.Request(manifest["url"], headers={"User-Agent": "TypeNext-public-FIM-recipe/0.1"})
    with urllib.request.urlopen(request, timeout=45) as response:
        raw = response.read(manifest["bytes"] + 1)
    return verified_body(raw, manifest)


def make_examples(text: str, limit: int = 1024, seed: int = 7, window_words: int = 110) -> list[dict[str, str]]:
    """Deterministic non-overlapping windows; no train/validation mixing."""
    if len(text) > 2_000_000 or not 1 <= limit <= 4096 or not 32 <= window_words <= 180:
        raise ValueError("Dataset preparation limits exceeded.")
    rng = random.Random(seed)
    examples: list[dict[str, str]] = []
    paragraphs = re.split(r"\n\s*\n", text)
    rng.shuffle(paragraphs)
    for paragraph in paragraphs:
        words = list(re.finditer(r"\S+", paragraph))
        for offset in range(0, len(words), window_words):
            window = words[offset:offset + window_words]
            if len(window) < 32:
                continue
            original = paragraph[window[0].start():window[-1].end()]
            local_words = list(re.finditer(r"\S+", original))
            left = rng.randint(8, len(local_words) - 20)
            middle_words = rng.randint(2, min(12, len(local_words) - left - 8))
            begin = local_words[left].start()
            end = local_words[left + middle_words].start()
            example = {"prefix": original[:begin], "middle": original[begin:end], "suffix": original[end:], "original": original}
            assert example["prefix"] + example["middle"] + example["suffix"] == original
            examples.append(example)
            if len(examples) >= limit:
                return examples
    return examples


def fim_prompt_ids(prefix: str, suffix: str, tokenizer) -> list[int]:
    """Identical BOS/PSM prompt ordering for training and later inference."""
    prompt = FIM_TOKENS[0] + prefix + FIM_TOKENS[1] + suffix + FIM_TOKENS[2]
    prefix_ids = tokenizer.encode(prompt, add_special_tokens=False)
    bos = [tokenizer.bos_token_id] if tokenizer.bos_token_id is not None else []
    return bos + prefix_ids


def encode_fim(example: dict[str, str], tokenizer, max_tokens: int = 384) -> dict | None:
    """PSM FIM layout. Only missing text and the end marker contribute to loss."""
    prefix_ids = fim_prompt_ids(example["prefix"], example["suffix"], tokenizer)
    target_ids = tokenizer.encode(example["middle"], add_special_tokens=False) + [tokenizer.convert_tokens_to_ids(FIM_TOKENS[3])]
    input_ids = prefix_ids + target_ids
    if len(input_ids) > max_tokens or len(target_ids) > 40:
        return None
    return {"input_ids": input_ids, "attention_mask": [1] * len(input_ids), "labels": [-100] * len(prefix_ids) + target_ids}
