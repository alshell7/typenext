import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const directory = path.dirname(fileURLToPath(import.meta.url))
const helper = await readFile(path.join(directory, 'fim_data.py'), 'utf8')
const cells = []
const markdown = source =>
  cells.push({
    cell_type: 'markdown',
    metadata: {},
    source: source.split(/(?<=\n)/u),
  })
const code = source =>
  cells.push({
    cell_type: 'code',
    metadata: {},
    source: source.split(/(?<=\n)/u),
    execution_count: null,
    outputs: [],
  })
markdown(
  `# TypeNext · a small prose FIM training experiment\n\nThis notebook fine-tunes **SmolLM2-135M** on a prefix/suffix/middle objective using two pinned public-domain novels. It is a runnable recipe, **not a trained checkpoint or a quality claim**. No notebook has been trained by the maintainers for this change.\n\nIn Colab choose **Runtime → Change runtime type → T4 GPU**, then run cells in order. The default run is bounded to 100 optimizer steps and short 384-token sequences. Public model/data downloads occur in your Colab runtime; no TypeNext notes, API keys or private references are read.\n\nThe shipped optional model in TypeNext is the original 135M instruction model, not the result of this experiment. Do not replace it with a fine-tune until held-out evaluation, source licensing and tokenizer/export compatibility have been checked.\n`
)
markdown(
  `## Sources and scope\n\n- Base model: [HuggingFaceTB/SmolLM2-135M](https://huggingface.co/HuggingFaceTB/SmolLM2-135M), Apache 2.0, immutable revision 93efa2f097d58c2a74874c7e644dbc9b0cee75a2.\n- Train: Jane Austen’s [Pride and Prejudice](https://www.gutenberg.org/ebooks/1342). Validation: Lewis Carroll’s [Alice’s Adventures in Wonderland](https://www.gutenberg.org/ebooks/11). Gutenberg identifies these editions as public domain in the US; check your jurisdiction before redistribution. Their body text is used without the Gutenberg header/license appendix, with provenance retained below. Exact HTTP bytes are SHA-256 pinned; changed bytes stop the run.\n- [FIM objective paper](https://arxiv.org/abs/2207.14255): prefix + suffix + middle permutation. This recipe adds explicit special tokens and trains their embeddings with the whole small model. It masks all prompt/suffix labels; only the missing middle and its end marker are supervised.\n\nThese two nineteenth-century novels are a **small biased demonstration corpus**. They do not cover modern nonfiction, multilingual writing, factual grounding or individual writing style. A larger consented/licensed corpus and manual evaluation are needed for a useful released writing model. Train/validation split is by entire book **before** windows, so adjacent passages do not cross the split.\n`
)
code(
  `%pip -q install "transformers==4.57.6" "accelerate==1.12.0" "safetensors==0.6.2"\n`
)
code(
  `import json, math, os, random, time\nfrom pathlib import Path\nos.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"\nos.environ["WANDB_DISABLED"] = "true"\nimport torch\nfrom transformers import AutoModelForCausalLM, AutoTokenizer, Trainer, TrainingArguments, set_seed\n\nos.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"\nos.environ["WANDB_DISABLED"] = "true"\nset_seed(7)\nassert torch.cuda.is_available(), "Select a GPU runtime; this notebook intentionally does not launch a slow CPU training run."\nprint({"torch": torch.__version__, "gpu": torch.cuda.get_device_name(0)})\nMODEL_ID = "HuggingFaceTB/SmolLM2-135M"\nREVISION = "93efa2f097d58c2a74874c7e644dbc9b0cee75a2"\nOUTPUT = Path("/content/typenext-fim-135m")\nMAX_STEPS = 100\nMAX_TOKENS = 384\nOUTPUT.mkdir(parents=True, exist_ok=True)\n`
)
code(helper + '\n')
code(
  `tokenizer = AutoTokenizer.from_pretrained(MODEL_ID, revision=REVISION, trust_remote_code=False)\nmodel = AutoModelForCausalLM.from_pretrained(MODEL_ID, revision=REVISION, torch_dtype=torch.float32, attn_implementation="eager", trust_remote_code=False)\nadded = tokenizer.add_special_tokens({"additional_special_tokens": FIM_TOKENS})\nmodel.resize_token_embeddings(len(tokenizer))\nif tokenizer.pad_token_id is None:\n    tokenizer.pad_token = tokenizer.eos_token\nmodel.config.pad_token_id = tokenizer.pad_token_id\nmodel.generation_config.eos_token_id = [tokenizer.eos_token_id, tokenizer.convert_tokens_to_ids(FIM_TOKENS[3])]\nmodel.config.use_cache = False\nmodel.gradient_checkpointing_enable()\nprint({"parameters": model.num_parameters(), "added_fim_tokens": added, "fim_ids": {token: tokenizer.convert_tokens_to_ids(token) for token in FIM_TOKENS}})\n`
)
code(
  `books = {split: download_book(manifest) for split, manifest in BOOKS.items()}\nexamples = {split: make_examples(body, limit=1024 if split == "train" else 96, seed=7) for split, body in books.items()}\nrows = {split: [row for example in records if (row := encode_fim(example, tokenizer, MAX_TOKENS)) is not None] for split, records in examples.items()}\nassert len(rows["train"]) >=100 and len(rows["validation"]) >=16, "Too few bounded FIM examples; inspect source preparation."\n# Retain ordinary causal writing in one fifth of additional examples.\nfor example in examples["train"][::5]:\n    ids = tokenizer.encode(example["original"], add_special_tokens=True)[:MAX_TOKENS]\n    rows["train"].append({"input_ids": ids, "attention_mask": [1] * len(ids), "labels": ids[:]})\nrandom.Random(7).shuffle(rows["train"])\nprovenance = {"model": MODEL_ID, "revision": REVISION, "model_license": "Apache-2.0", "dataset": BOOKS, "split": "entire books before windows", "fim_tokens": FIM_TOKENS, "trained": False, "steps": MAX_STEPS, "max_tokens": MAX_TOKENS}\n(OUTPUT / "training-provenance.json").write_text(json.dumps(provenance, indent=2), encoding="utf-8")\nprint({split: len(records) for split, records in rows.items()})\n`
)
code(
  `class PreparedDataset(torch.utils.data.Dataset):\n    def __init__(self, records): self.records = records\n    def __len__(self): return len(self.records)\n    def __getitem__(self, index): return self.records[index]\n\ndef collate(batch):\n    length = max(len(item["input_ids"]) for item in batch)\n    return {\n        "input_ids": torch.tensor([item["input_ids"] + [tokenizer.pad_token_id] * (length - len(item["input_ids"])) for item in batch]),\n        "attention_mask": torch.tensor([item["attention_mask"] + [0] * (length - len(item["input_ids"])) for item in batch]),\n        "labels": torch.tensor([item["labels"] + [-100] * (length - len(item["input_ids"])) for item in batch]),\n    }\n\narguments = TrainingArguments(\n    output_dir=str(OUTPUT / "checkpoints"), max_steps=MAX_STEPS,\n    per_device_train_batch_size=2, per_device_eval_batch_size=2, gradient_accumulation_steps=4,\n    learning_rate=3e-5, warmup_steps=10, weight_decay=0.01,\n    fp16=True, gradient_checkpointing=True, logging_steps=10,\n    eval_strategy="steps", eval_steps=50, save_strategy="no",\n    report_to="none", seed=7, data_seed=7, dataloader_num_workers=0,\n)\ntrainer = Trainer(model=model, args=arguments, train_dataset=PreparedDataset(rows["train"]), eval_dataset=PreparedDataset(rows["validation"]), data_collator=collate, processing_class=tokenizer)\nbaseline = trainer.evaluate()\nprint({"untrained_fim_validation_loss": baseline["eval_loss"]})\n`
)
markdown(
  `## Train and record evidence\n\nThe baseline above contains newly initialized FIM tokens and is not a production comparison with the app’s instruction model. Validation loss alone is not writing quality. Interrupting this cell leaves \`trained:false\` provenance and must not be described as a completed fine-tune.\n`
)
code(
  `torch.cuda.reset_peak_memory_stats()\nstarted = time.perf_counter()\ntraining_result = trainer.train()\nvalidation = trainer.evaluate()\ntrainer.save_model(str(OUTPUT))\ntokenizer.save_pretrained(str(OUTPUT))\nmodel.config.use_cache = True\nmodel.config.save_pretrained(str(OUTPUT))\nprovenance.update({"trained": True, "training_seconds": time.perf_counter() - started, "peak_cuda_bytes": torch.cuda.max_memory_allocated(), "train_metrics": training_result.metrics, "validation_metrics": validation, "baseline_validation_loss": baseline["eval_loss"], "python_dependencies": {"transformers": "4.57.6", "accelerate": "1.12.0"}})\n(OUTPUT / "training-provenance.json").write_text(json.dumps(provenance, indent=2), encoding="utf-8")\nprint({"training_seconds": provenance["training_seconds"], "peak_cuda_GiB": provenance["peak_cuda_bytes"] /2**30, "before_loss": baseline["eval_loss"], "after_loss": validation["eval_loss"]})\n`
)
code(
  `model.eval()\nmodel.config.use_cache = True\nfim_end = tokenizer.convert_tokens_to_ids(FIM_TOKENS[3])\n\n@torch.inference_mode()\ndef infill(prefix, suffix, max_new_tokens=32):\n    ids = fim_prompt_ids(prefix, suffix, tokenizer)\n    encoded = {"input_ids": torch.tensor([ids], device=model.device), "attention_mask": torch.ones((1,len(ids)), dtype=torch.long, device=model.device)}\n    assert encoded["input_ids"].shape[-1] <=MAX_TOKENS, "Shorten context; do not silently drop the cursor."\n    started = time.perf_counter()\n    output = model.generate(**encoded, max_new_tokens=max_new_tokens, do_sample=False, eos_token_id=fim_end, pad_token_id=tokenizer.pad_token_id)\n    new_ids = output[0, encoded["input_ids"].shape[-1]:]\n    return tokenizer.decode(new_ids, skip_special_tokens=True), time.perf_counter() - started\n\nchecks = []\nfor example in examples["validation"][:8]:\n    insertion, seconds = infill(example["prefix"], example["suffix"])\n    checks.append({"prefix": example["prefix"], "suffix": example["suffix"], "expected_public_middle": example["middle"], "generated": insertion, "seconds": seconds, "exact_middle": insertion ==example["middle"], "suffix_echo": example["suffix"][:32].strip() in insertion})\n(OUTPUT / "heldout-infill.json").write_text(json.dumps(checks, indent=2), encoding="utf-8")\n# Inspect these reconstructions, including suffix boundaries, before treating it as useful.\nfor item in checks[:3]:\n    print({"reconstructed": item["prefix"] + item["generated"] +item["suffix"], "exact_middle": item["exact_middle"], "suffix_echo": item["suffix_echo"]})\n`
)
markdown(
  `## Evaluate the actual writing task\n\nAlso test modern synthetic prose: title-only starts, the writer’s objective, existing lowercase suffixes, blank lines, markdown headings, no-reference notes and noisy reference excerpts. Score grammatical compatibility, meaning preservation, suffix duplication and whether the result makes unsupported factual claims. This small corpus has no objective/RAG conditioning examples, so those capabilities must not be inferred from lower loss. Keep automatic suggestions short and retain the deterministic offline fallback.\n\nA released FIM model needs the same tokenizer markers and prompt order at inference. The app’s shipped instruction worker does not automatically discover, download or accept this custom checkpoint. The export below is a developer artifact that needs its own pinned manifest and dedicated FIM formatter; it is not a drop-in change of model ID in the existing chat worker.\n`
)
markdown(
  `## Optional ONNX export and quantization\n\nThis can take additional CPU RAM/time. Run it after reviewing evaluation. [Optimum export docs](https://huggingface.co/docs/optimum-onnx/onnx/usage_guides/export_a_model) describe \`text-generation-with-past\`. An exported file still needs runtime parity tests; quantization can change completions. No unreviewed weights are published or uploaded by this notebook.\n`
)
code(`%pip -q install "optimum-onnx==0.1.0" "onnxruntime==1.30.0"\n`)
code(
  `import gc, shutil, subprocess\n# Release training GPU state before a CPU exporter reads the saved checkpoint.\ntrainer.model = None\ndel trainer, model\ngc.collect()\ntorch.cuda.empty_cache()\nONNX = Path("/content/typenext-fim-135m-onnx")\nsubprocess.run(["optimum-cli", "export", "onnx", "--model", str(OUTPUT), "--task", "text-generation-with-past", "--opset", "17", "--device", "cpu", str(ONNX)], check=True)\nfrom onnxruntime.quantization import QuantType, quantize_dynamic\nfor exported in ONNX.glob("*.onnx"):\n    quantized = exported.with_name(exported.stem +"_quantized.onnx")\n    quantize_dynamic(str(exported), str(quantized), weight_type=QuantType.QInt8, per_channel=True, op_types_to_quantize=["MatMul"])\n# Preserve provenance and special tokens with every export.\nshutil.copy2(OUTPUT / "training-provenance.json", ONNX / "training-provenance.json")\nshutil.copy2(OUTPUT / "heldout-infill.json", ONNX / "heldout-infill.json")\nprint({"exported_files": [file.name for file in ONNX.iterdir()]})\n`
)
code(
  `import hashlib\nmanifest = {file.name: {"bytes": file.stat().st_size, "sha256": hashlib.file_digest(file.open("rb"), "sha256").hexdigest()} for file in ONNX.iterdir() if file.is_file()}\n(ONNX / "export-manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")\narchive = shutil.make_archive("/content/typenext-fim-135m-onnx", "zip", ONNX)\nfrom google.colab import files\nfiles.download(archive)\n`
)
markdown(
  `## What has and has not been verified\n\nThe repository validates notebook JSON/Python syntax, source-byte pins, exact prefix/middle/suffix reconstruction, middle-only loss masks and input bounds. **The training, GPU evaluation, ONNX export and quantized runtime parity cells have not been executed here**: the available Colab browser could not initialize its kernel. Record your completed run’s metrics/provenance instead of treating the recipe as evidence of a trained or improved model.\n\nNever upload your private notes, API-key file, personal PDFs or reference library to this notebook unless you separately choose to process them in Google Colab. The default sources are only the two public novels above.\n`
)
cells.forEach((cell, index) => {
  cell.id = `typenext-${String(index + 1).padStart(2, '0')}`
})
await writeFile(
  path.join(directory, 'typenext-prose-fim.ipynb'),
  JSON.stringify(
    {
      cells,
      metadata: {
        kernelspec: {
          display_name: 'Python3',
          language: 'python',
          name: 'python3',
        },
        language_info: { name: 'python', version: '3.11' },
        colab: { name: 'TypeNext-prose-FIM.ipynb', provenance: [] },
        accelerator: 'GPU',
      },
      nbformat: 4,
      nbformat_minor: 5,
    },
    null,
    2
  ) + '\n'
)
console.log(
  'Generated training/typenext-prose-fim.ipynb; cells remain unexecuted.'
)
