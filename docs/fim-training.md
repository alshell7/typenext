# Prose FIM training recipe

`training/typenext-prose-fim.ipynb` is a runnable Google Colab recipe for a small fill-in-the-middle experiment. It is **not a trained model**. Training, GPU evaluation, ONNX export and quantized runtime parity have not been executed for this change: the browser automation process failed to start before reaching Colab, including a retry. No improved checkpoint is claimed or shipped.

The notebook and helpers were checked locally for JSON/Python syntax, deterministic data preparation, exact prefix/middle/suffix reconstruction, source hash rejection, bounded inputs and middle-only loss masks. These checks validate the recipe's preparation logic; they do not validate training convergence or export compatibility.

## Run in Colab

1. Upload `training/typenext-prose-fim.ipynb` to Colab. Choose **Runtime → Change runtime type → T4 GPU**.
2. Run the dependency, public-source preparation and baseline-evaluation cells in order. Downloads contain only the public base model and two public novels. No TypeNext files, API keys or private context are read.
3. Run the bounded 100-step training experiment, then inspect held-out loss, generated middles and full reconstructions. Record the notebook's timing, CUDA memory and provenance outputs.
4. Only after reviewing those examples, run the optional ONNX export/quantization cells. Download the resulting developer artifact and its hash manifest. Do not treat successful export as runtime parity.

Colab availability and hardware vary. The recipe deliberately refuses CPU training when no CUDA runtime is available. Training dependencies are pinned to Transformers 4.57.6, Accelerate 1.12.0 and Safetensors 0.6.2. Optional export uses Optimum-ONNX 0.1.0 and ONNX Runtime 1.30.0; its declared Transformers version range includes this recipe's pin. The notebook uses the runtime's PyTorch installation and records that version in its output.

## Model, data and objective

The base is [HuggingFaceTB/SmolLM2-135M](https://huggingface.co/HuggingFaceTB/SmolLM2-135M), Apache-2.0, at immutable revision `93efa2f097d58c2a74874c7e644dbc9b0cee75a2`. It uses the base causal model to teach explicit prefix/suffix/middle behavior. The shipped TypeNext model remains the original instruction-tuned ONNX model; it is not the product of this notebook.

Training text is Austen's [Pride and Prejudice](https://www.gutenberg.org/ebooks/1342), while validation text is Carroll's [Alice's Adventures in Wonderland](https://www.gutenberg.org/ebooks/11). The official editions are identified as public domain in the United States. Check the applicable jurisdiction before redistributing a derived artifact. Exact HTTP byte counts and SHA-256 values live in `training/fim_data.py`; altered source bytes stop the run. Gutenberg's header and license appendix are removed from the training body while source provenance remains with the output. Whole books are split before windows, so adjacent passages cannot leak between training and validation.

The [original FIM paper](https://arxiv.org/abs/2207.14255) describes causal training over reordered prefix, suffix and middle. This experiment introduces four tokenizer markers:

```text
<|fim_prefix|> PREFIX <|fim_suffix|> SUFFIX <|fim_middle|> MIDDLE <|fim_end|>
```

Prompt/suffix labels are masked with `-100`. Only the missing middle and its end marker contribute to the FIM loss. The tokenizer and full 135M model are resized and trained together so new marker embeddings are not left frozen. One additional ordinary causal example is retained per five prepared examples. The default uses 1,024 training windows, 96 validation windows, a 384-token input cap and short 2–12-word middles. Oversized encoded examples are rejected rather than silently cutting away the suffix. Training and infill share `fim_prompt_ids`, avoiding a different BOS/marker sequence at inference.

Two nineteenth-century novels are a biased demonstration corpus. Lower held-out loss on that corpus does not establish modern writing usefulness, factual grounding, reference conditioning, multilingual quality or preservation of a writer's objective. The recipe explicitly includes a manual evaluation step for blank starts, prose with objectives, lowercase suffixes, Markdown, noisy references and unsupported claims. A useful released model requires a broader consented/licensed corpus and held-out writing-task evaluation.

## Export and integration boundaries

The optional export follows the [official Optimum ONNX task guide](https://huggingface.co/docs/optimum-onnx/onnx/usage_guides/export_a_model) with `text-generation-with-past`, CPU export and opset 17. Dynamic per-channel QInt8 quantization targets MatMul. It preserves tokenizer files, training provenance, public held-out examples and a SHA-256 manifest. Export/quantization can change generation; compare PyTorch, ONNX float and quantized outputs before shipping.

This artifact needs its own reviewed download manifest, dedicated native-FIM formatter, tokenizer parity tests, license notice and actual browser/runtime evaluation. Changing the model ID in the instruction worker is insufficient. No automatic upload, publishing, installation or replacement of the TypeNext model occurs in the notebook.

Rebuild and verify the preparation logic without downloading or training a model:

```powershell
node training/build-notebook.mjs
python -m unittest discover -s training -p "test_*.py"
```

`training/build-notebook.mjs` embeds the same tested helper in the notebook and leaves every execution count null with empty outputs. The checked-in notebook remains clearly unexecuted. Completed training runs should keep their generated provenance/evaluation files rather than replacing this status with an unverified quality claim.
