# Confidence calibration

Source: [src/calibration.ts](../../src/calibration.ts)

`CalibrationSample` contains the task identifier, independent revision family, raw binary score, human-labelled finding correctness and evidence-window count. `fitCalibration` fits a bounded temperature on the log odds of those scores. It returns a `CalibrationFit` with the training families and fit version.

`applyCalibration` transforms a score using the fitted temperature for the matching task. `evaluateCalibration` rejects evaluation families present in training. It returns raw and calibrated `CalibrationMetrics` with Brier score, expected calibration error, sample count and `ReliabilityBin` values for plotting observed accuracy against mean confidence. `WindowCalibration` reports separate results for one, two to four, and five or more windows.

The input label describes finding correctness, not the NLI class. The fit does not alter the raw inference cache or default guard thresholds. The caller supplies independently labelled examples and validates generalisation on held-out revisions. Synthetic unit tests verify the calculation; they do not establish real model calibration.
