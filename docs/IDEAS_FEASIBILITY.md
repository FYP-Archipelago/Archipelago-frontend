# Possible directions: feasibility report

Nine ideas were raised as possible next steps for Archipelago. This report says,
for each one, whether it can be built on what the project already has, whether it
would actually help, and what it would cost. Where a claim could be measured on
our own runs it was. The probes ran on the two sample runs in `data/`: a
fully-connected DE run (5 islands, 3,866 evaluations) and a ring DE run
(4 islands, 1,786 evaluations).

None of this is in the UI yet, by design.

## The short version

| Idea | Verdict | Why, in one line |
|---|---|---|
| **SHAP (Shapley values)** | **Build now** | Measured: 39 ms for every coalition on our largest run, credits differ by island, and the answer explains the run itself. |
| **Node info on click** | **Build now** | Cheap, already designed (plan M4), and every other explanation feature needs a selected node to talk about. |
| **MMD between islands** | **Build next** | Measured: it cleanly separates a ring run from a fully-connected one. One number that answers "did the islands explore different regions?" |
| **Several runs in one view** | **Build next** | The data layer was built keyed by run for this. The STN literature's "merged STN" is the established way to draw it. |
| **Box to see what's important** | **Build next** (manual), later (automatic) | Manual region select is simple. Automatic "important regions" has a published method (attractor analysis) that needs no local search. |
| **AI explanation with context** | **Prototype after the two above** | Real precedent (STN Analytics ships an LLM assistant), but only credible when it narrates numbers we computed, not the model's guesses. |
| **Streaming** | **Later** | The harness can feed it cheaply and the builder already handles batches. Clustering cannot run live. Needs a live layout. |
| **Python package / Volpe** | **Package: small fix now. Volpe: blocked** | The package name collides on PyPI. Volpe returns only best individuals, which is too little to draw an STN from. |
| **LON on the archipelago** | **Low priority** | LONs need local optima, which need local search our algorithms don't have. The STN already is the right model; attractor networks give the LON-like view. |
| **Grad-CAM** | **Drop** | Needs a convolutional network's gradients. There is no network in an evolutionary run. |
| **LIME** | **Drop** | Explains a surrogate model, not the run, and is unstable. Shapley covers the same ground better. |

---

## 1. SHAP / Shapley values — build now

**What it would do.** Say how much each island (or operator, or migration)
contributed to the best solution the run found.

**The trap to avoid.** The obvious version asks "what if this island had not
existed?". Our islands run the same algorithm with the same settings, so they are
interchangeable in that game, and Shapley's symmetry rule then forces every island
to get an equal share, whatever happened in the run. That would be a correct
answer that explains nothing.

**The version that works** is built from what actually happened. Each island's
individuals, and the migrations between them, are players. A coalition of islands
is only allowed to use its own individuals, and an individual only counts if its
parents are also available. So a lineage that passed through three islands needs
all three. The coalition's value is how far its lineage gets from a typical
starting fitness.

**Measured on our runs:**

| | Fully connected (5 islands) | Ring (4 islands) |
|---|---|---|
| Winner's ancestry crosses islands? | Yes: all 5 islands, 318 ancestors, 143 migration arrivals on the path | Yes: 3 of 4 islands. Island 3 contributed nothing to the winner. |
| Time for every coalition | **39 ms** (32 coalitions) | **9 ms** (16 coalitions) |
| Island credits (sum = total improvement) | 26.8, 37.8, 24.3, 36.4, 40.2 — sum 165.54, exactly the total | 25.8, 37.0, 33.5, 21.1 — sum 117.37, exactly the total |

Two things the numbers show. First, the credits are not equal, so the symmetry trap
is avoided. Second, the ring run's island 3 still gets credit (21.1) even though it
is absent from the winner's ancestry, because on its own it made real progress. So
there are two honest questions here, and the report recommends showing both:

- *Who fed the winner?* Ancestry only. Island 3 gets zero.
- *Who made progress?* The coalition game above. Island 3 gets 21.1.

The same code works with players swapped to operators or to individual migration
events, which gives "which transfers mattered".

**Fit.** This is the explainability contribution the reviewers asked for, and it
explains the search itself, not a model of it. It needs only `parent_ids` from the
logs we already write. Precedent: Shapley values have been used to explain another
optimiser's decisions, and people working with those explanations did measurably
better ([ShapleyBO](https://arxiv.org/abs/2403.04629)).

**Cost.** Small: the probe is about a hundred lines. Coalitions grow as 2^K, which is
fine up to about 15 islands; past that, sample coalitions instead of listing them.

## 2. Node info on click — build now

**What it would do.** Click a node and see its fitness, visits, island, the parents
it came from and the operator that made it, with "walk the lineage" back to the
start.

**Fit.** Already designed as milestone M4 of the rewrite: the edge list becomes two
lookup indexes (children and parents) so a node's parents can be found instantly.
Every explanation feature after it needs this. Shapley per node, the AI assistant
and region selection all start from "this node".

**Cost.** Small to medium. No new data is needed.

## 3. MMD between islands — build next

**What it would do.** MMD (maximum mean discrepancy) is a distance between two
sets of points that makes no assumption about their shape. Between islands, it
says whether they searched different regions or the same one.

**Measured on our runs** (a larger number means more different; "noise" is what
two random halves of the same data score):

| | Fully connected | Ring |
|---|---|---|
| Island pairs | 0.002 – 0.026 | 0.018 – 0.061 |
| Noise level | 0.002 | 0.006 |
| Median pair | 0.008 | 0.055, about 7× the fully-connected median |
| Reading | Islands stay close: most pairs within a few times the noise level | Every pair 3–10× above noise: the ring keeps islands apart |
| One island, early vs late | 0.29 — it moves far more over time than it differs from its neighbours | 0.07 |
| Time, all pairs | ~1 s for 3,300 points | 0.2 s |

That is a real finding in two numbers: the topology controls how separate the
islands stay, and MMD measures it directly.

**Fit.** It answers the first question on the About page ("were the islands
exploring different regions?") with one number, and it is already listed there as
the planned analytics stage. It also has a streaming form: MMD over sliding windows
is an established online change detector
([MMD on exponential windows](https://arxiv.org/html/2205.12706v3)), which would
flag the moment an island's search changes.

**Cost.** Small. The simple version is quadratic in points. For 100k evaluations,
compute it on samples or on the clustered nodes.

## 4. Several runs in one view — build next

**What it would do.** Load several runs (different algorithms, seeds or
topologies) and compare them in one picture.

**Fit.** Good, and anticipated: the data layer stores runs by name, so a second
run needs no redesign. The STN literature has an established way to draw this.
Ochoa et al. merge the networks of two or three algorithms into one, marking the
locations more than one visited
([Ochoa, Malan & Blum 2021](https://www.sciencedirect.com/science/article/abs/pii/S1568494621004154)).

**What needs deciding.** All runs must share one projection (fit the PCA on all
runs together), otherwise positions are not comparable. Two full clouds in one 3D
box will be crowded, so offer side-by-side views with a linked camera, as well as
a merged view.

**Cost.** Medium.

## 5. A box to see what's important — build next (manual), later (automatic)

**Manual.** Drag a box around a region and get its numbers: how many locations,
from which islands, the best fitness there, the migrations in and out. Simple once
node info exists.

**Automatic.** "Where is the important stuff" has a published answer that fits our
case: *attractor analysis* finds the regions where a search stalls, and works for
algorithms without local search, such as DE and CMA-ES
([Stalling in Space](https://arxiv.org/abs/2412.15848)). Combined with Shapley
credit and visit counts, this could outline regions automatically instead of
waiting for the user to draw them.

**Cost.** Manual: small. Automatic: medium.

## 6. AI explanation with context — prototype after 1 and 2

**What it would do.** Ask a question in plain language ("why did island 3 stall?")
and get an answer grounded in this run.

**Precedent.** STN Analytics, the reference STN tool, ships an LLM assistant
alongside its views.

**The risk that decides the design.** In a research review, an explanation that
sounds right but is not grounded is worse than none. The assistant should only
narrate facts the app has computed: Shapley credits, MMD values, the selected
node, termination reasons. It should cite them, and say so when it doesn't know.
That is why it comes after Shapley and node info. Without them it would have
nothing trustworthy to say.

**Cost.** Medium. An API key and per-question cost, and run data leaves the machine,
which may matter for runs from Volpe.

## 7. Streaming — later

**What's already there.** More than expected:

- **The harness.** It already streams every event from the islands to a central
  collector, and has a fan-out hook that would feed a live view without touching
  the islands (`MultiSink` / `CallbackSink` in `archipelago_logging/sinks.py`,
  injected in `orchestrator/master.py`).
- **The frontend builder.** It accepts rows in batches and gives the same network
  as a one-shot load. A test proves this.

**What's hard.** The clustering pipeline cannot run live. It needs the whole run to
tune its thresholds, so labels would change on every refresh. Keep clustering as
an explicit "cluster what we have so far" button. DenStream is the one stage that is
online by nature ([Cao et al. 2006](https://www.cs.sfu.ca/~ester/papers/SDM2006.DenStream.final.pdf)),
and could be made incremental later. The layout also needs to add new nodes without
reshuffling old ones.

**Cost.** Medium to large, and it touches the harness repo.

## 8. Python package and Volpe — package now, Volpe blocked

**Package.** `dEA-clustering` already installs with a `cluster` command, but two
things block publishing it:

- Its package name, `archipelago`, is already taken on PyPI by an unrelated chip
  design tool. `archipelago-clustering` and `archipelago-logging` are free.
- The API imports `archipelago_clustering`, but the package is named `clustering`,
  so the API fails at import today. Its own test suite fails at collection.

Renaming the package to `archipelago_clustering` fixes both at once.

**Volpe.** Volpe is the job runner from the Evolutionary Algorithms On Click
platform. It runs a job and returns *best individuals with their fitness*
([EvOC](https://github.com/Evolutionary-Algorithms-On-Click)). That is not enough
for an STN, which needs every evaluation and its parents. Integration therefore
means Volpe jobs must run our logging library inside their containers. Packaging it
as `archipelago-logging` makes that a one-line install for the job, but it needs
agreement from whoever owns Volpe. Once they log in our format, their runs work in
Archipelago unchanged.

## 9. LON on the archipelago — low priority

Local optima networks draw the local optima of a problem and the moves between
them. They need a definition of "local optimum", which in practice means running a
local search. DE, PSO and the other baseline algorithms don't include one. STNs
were introduced precisely for algorithms like ours
([Ochoa et al. 2020](https://link.springer.com/chapter/10.1007/978-3-030-43722-0_5)).
A LON would describe the problem's landscape, built separately from our logs, rather
than what our run did. The attractor-analysis view in idea 5 gives the LON-like
"where does the search get stuck" picture, directly from our logs.

## 10. Grad-CAM and LIME — drop

**Grad-CAM** highlights which parts of an image a convolutional network used, by
reading the network's gradients. An evolutionary run has no network and no
gradients, so there is nothing for it to read.

**LIME** fits a small local model to explain one prediction of a bigger model. We
would first have to train a model of the run (for example, genome → fitness) and
then explain that model, not the run. Its explanations also change noticeably
between repeated calls. Shapley over the run's own events (idea 1) answers the same
question directly.

---

## Things found in the org repos while researching this

- **Two fitness conventions.** The clustering repo's new fitness plot (`--fplot`,
  9 Sep) draws the best fitness at the *top*. The Streamlit app and the new frontend
  draw it at the *bottom*. The new frontend offers both ("Best at top"). Worth
  agreeing on one for the paper.
- **The API cannot import the clustering package** (see idea 8), and its run list
  returns empty metadata because it reads an `event` field where the log writes
  `type`.
- **The clustering pipeline cannot run on Windows** as committed: the CSV size limit
  it sets overflows there. A fix is in the local clone as
  `windows-csv-limit.patch`, not yet pushed.
- **Local clones are behind or dirty.** The local `dEA-clustering` still carries a
  corrupted commit that the remote replaced, and is two commits behind. The local
  `archipelago-api` has an uncommitted import fix and an added `numpy` requirement.

## Suggested order

1. Node info on click, then Shapley credit on it (islands first, then migrations).
   This is the explainability result for the next review.
2. MMD between islands and over time, alongside Shapley on the same page.
3. Region box (manual) and several runs in one view.
4. The AI assistant, grounded only in 1–3.
5. Streaming, then Volpe once its owners agree to log in our format.
