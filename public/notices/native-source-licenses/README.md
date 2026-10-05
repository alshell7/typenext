# Reviewed native license sources

These files supplement license texts omitted from the published Cargo crates in TypeNext's locked dependency set. They retain the dependencies' own licenses and do not relicense them under TypeNext's MIT license.

The audit covers the resolved Windows x64, macOS arm64 and macOS x64 dependency sets. There are 46 reviewed package/version records: 28 Windows gaps and 18 additional macOS gaps. Of these, 24 records retain 42 complete original upstream license/copyright files from the exact published Git revision, including monorepo-root files outside the packaged crate directory.

Each package folder has a `source.json` with the original Cargo repository/source identity, published revision and path, original HTTPS source URLs, and SHA-256 hashes. For `fxhash` 0.2.1 and `mac` 0.1.1, the older crates have no packaged Git metadata. Their cached published archive hashes match `Cargo.lock`, and the recorded upstream revisions match the included original manifests and source bytes exactly.

## Referenced standard licenses

The remaining 22 packages declare license options but do not contain a complete license text in their exact upstream revision. Their records explicitly use `kind: "referenced-standard-license"`. The `upstream/` files retain the exact original declaration, attribution and representative source. The separate standard text is identified as a reference, rather than a reconstructed upstream copyright-bearing license.

- Apache-2.0 is selected only where the upstream declaration permits it. The complete standard text is copied verbatim from the [Apache Software Foundation](https://www.apache.org/licenses/LICENSE-2.0.txt).
- MIT is selected for the seven MIT-only packages. The text is extracted from the four license paragraphs on the [Open Source Initiative's canonical MIT page](https://opensource.org/license/mit). The original `<YEAR>` and `<COPYRIGHT HOLDER>` placeholders remain unchanged. No copyright holder or year is inferred from an author field or inserted into the standard text.

Original authors are retained as supplied by Cargo/upstream. For `fxhash`, the original source also retains the actual notice `Copyright 2015 The Rust Project Developers` and its original dual-license references. The `mac` README retains Jonathan Reem's author attribution and its MIT/Apache-2.0 declaration. The Objective-C monorepo's original `LICENSE.md` is included unchanged, including its Apple SDK discussion.

The release collector accepts reference records only for the explicitly reviewed package/version and selected license option. It checks the locked package/VCS identity, original pinned file hashes, canonical Foundation/OSI URL, and standard-text hash without fetching notices at build time. A new or changed dependency needs a fresh review.

## MPL corresponding source

See [selectors 0.24.0 source availability](selectors-0.24.0/SOURCE-AVAILABILITY.md). The target release collector copies the full unmodified published source for every dependency whose license expression includes MPL-2.0 into that dependency's `source/` folder beside its license. The linked upstream source is also recorded for audit and independent retrieval.
