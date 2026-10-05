import hashlib
import unittest

from fim_data import FIM_TOKENS, encode_fim, fim_prompt_ids, make_examples, verified_body


class TokenizerFixture:
    bos_token_id = 1

    def encode(self, text, add_special_tokens=False):
        return [ord(character) for character in text]

    def convert_tokens_to_ids(self, token):
        return 999 if token == FIM_TOKENS[3] else 0


class PublicFimDataTests(unittest.TestCase):
    def test_preserves_exact_prefix_middle_suffix_and_unicode(self):
        text = " ".join(["Quiet🌱", "thoughts,", "and", "rain."] * 40)
        examples = make_examples(text, seed=7)
        self.assertGreater(len(examples), 0)
        self.assertEqual(examples, make_examples(text, seed=7))
        for example in examples:
            self.assertEqual(example["prefix"] + example["middle"] + example["suffix"], example["original"])
            self.assertNotEqual(example["prefix"], "")
            self.assertNotEqual(example["suffix"], "")

    def test_only_middle_is_supervised_and_padding_is_not_added(self):
        encoded = encode_fim({"prefix": "Before ", "middle": "middle ", "suffix": "after."}, TokenizerFixture())
        self.assertIsNotNone(encoded)
        first_target = encoded["labels"].index(ord("m"))
        self.assertEqual(encoded["labels"][:first_target], [-100] * first_target)
        self.assertEqual(encoded["input_ids"][:first_target], fim_prompt_ids("Before ", "after.", TokenizerFixture()))
        self.assertEqual(encoded["labels"][first_target:], list(map(ord, "middle ")) + [999])
        self.assertEqual(len(encoded["input_ids"]), len(encoded["attention_mask"]))
        self.assertEqual(len(encoded["input_ids"]), len(encoded["labels"]))
        self.assertIsNone(encode_fim({"prefix": "Before ", "middle": "middle ", "suffix": "after."}, TokenizerFixture(), max_tokens=4))

    def test_header_license_boundaries_and_changed_bytes(self):
        raw = b"Metadata\n*** START OF THE PROJECT GUTENBERG EBOOK TEST ***\n\nPublic story.\n\n*** END OF THE PROJECT GUTENBERG EBOOK TEST ***\nLicense appendix"
        manifest = {"bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest()}
        self.assertEqual(verified_body(raw, manifest), "Public story.")
        with self.assertRaises(ValueError):
            verified_body(raw + b"changed", manifest)
        missing = b"No valid source boundaries"
        with self.assertRaises(ValueError):
            verified_body(missing, {"bytes": len(missing), "sha256": hashlib.sha256(missing).hexdigest()})

    def test_preparation_is_bounded_and_does_not_mix_short_lines(self):
        self.assertEqual(make_examples("Short sentence."), [])
        self.assertEqual(len(make_examples("word " * 1000, limit=2)), 2)
        with self.assertRaises(ValueError):
            make_examples("x" * 2_000_001)
        with self.assertRaises(ValueError):
            make_examples("word " * 100, limit=5000)


if __name__ == "__main__":
    unittest.main()
