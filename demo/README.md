# Demo — Bike Sharing exam

`bike-sharing-exam.ipynb` is a minimal notebook that works as an **exam for
the agent**: every task is stated in a markdown cell, and the code cell under
it starts empty. The agent completes the tasks in order — environment setup
included — while a human supervises. Nothing in the exam is pre-solved.

## Run it

1. Start JupiBuddy and open **this `demo/` folder** as the workspace.
2. Open `bike-sharing-exam.ipynb`.
3. Pick a kernel whose environment has `pandas`, `numpy`, `scikit-learn`,
   and `matplotlib` — or let the agent provision one (`create_venv` /
   `install_packages`); that choice is part of the demo.
4. Give the agent this instruction:

   > Work through the exam in `bike-sharing-exam.ipynb`. Complete every
   > empty code cell in order, run each one, and finish with the conclusion
   > in Task 5. If the environment is missing packages, set them up first.

## What a good run looks like (supervisor's answer key)

- All 5 tasks completed in order; every code cell ran without an unhandled
  error (an error the agent notices and fixes itself is a feature of the
  demo, not a failure).
- The split is chronological (train 2011 → test 2012) and `casual` /
  `registered` are **not** used as features.
- Ballpark test scores: Linear Regression RMSE roughly **100–140**,
  Random Forest RMSE roughly **40–70**, R² clearly higher for the forest.
  Exact numbers move with feature choices; the ordering must not.
- The predicted-vs-actual plot renders as an image, and Task 5 ends as a
  markdown conclusion naming the winner, the margin, and one caveat.

## Data

`data/hour.csv` (17,379 rows) and `data/day.csv` from the UCI Bike Sharing
dataset — Capital Bikeshare, Washington D.C., 2011–2012.

Citation: Fanaee-T, Hadi (2013). *Bike Sharing Dataset*. UCI Machine
Learning Repository. https://doi.org/10.24432/C5W894 — licensed CC BY 4.0.

The same exam skeleton (intro → filled setup → task/empty-cell pairs →
conclusion) can be re-skinned for other datasets; only the setup cell, the
task text, and the answer key change.
