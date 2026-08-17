# Failure Boundary Knowledge

## Required and Optional Operations

A failure boundary follows from whether an operation is required and which results must survive its failure.


## Failure Propagation and Visibility

A recoverable failure must retain the same meaning across containment, classification, aggregation, and caller or user visibility.


## Success-Path Losses

A value missing from an otherwise successful path is not a failure-propagation or continuation defect.

| Observation | Classification |
|-------------|----------------|
| Normal persistence omits a value | Value wiring or persistence |
| An optional operation's exception prevents returning the primary result | Failure boundary |
| An acquired resource escapes its release scope | Resource ownership |
