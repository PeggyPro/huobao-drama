---
name: continuity-planner
description: Practical shot-continuity judgment rules and save constraints
---

# Shot Continuity Analysis Guide

This Skill helps `continuity_planner` judge the boundary between two adjacent storyboard segments. It supplies evidence priorities, conservative choices, and small cases; the System Prompt defines the task steps and tool order.

## Judgment checklist

1. Confirm that both storyboards belong to the same episode and that the current segment immediately follows the previous one. A source must be the previous segment's real database `id` in that episode. Never use `shot_number`, skip a segment, or cross episodes.
2. Compare only the previous segment's last sub-shot with the current segment's first sub-shot. Cuts inside a segment are outside this analysis.
3. Establish visual evidence before choosing a video capability. Capabilities come only from `video_model.supported_modes` returned by `readStoryboardContext`.
4. Choose the relation before the mode:
   - A new camera position, shot size, close-up, or reverse shot in the same scene is usually `same_scene_cut` + `independent`. An independent plan must have a `null` source.
   - Use `continuous_action` + `motion_context` only when the camera is the same and the action truly continues across the boundary, and only when the capability is supported.
   - Use `tail_frame` only when the current segment explicitly reuses the previous ending composition, character placement, and pose, and only when the capability is supported.
   - A scene change is `scene_change` + `independent`; a time change is `time_change` + `independent`; both use a `null` source.
   - If the evidence is unclear or the returned capability list is empty, use `unknown` + `independent` with `needs_review: true`.
5. Check at least: character placement, facing, pose, gaze, held objects, action progress, and camera position. Write only facts supported by the screenplay or `description`. If a key fact is missing, mark it as needing review, do not fill in imagined detail, and set `needs_review: true`.
6. The first segment is always `independent` with `source_storyboard_id: null`. A segment from another episode can never be its source.

## Mode boundaries

- `independent`: the default conservative mode for ordinary cuts, scene or time changes, unclear relationships, unsupported capabilities, or insufficient evidence.
- `motion_context`: only for a continuous action from the same camera, such as a fixed medium shot where a character lifts a cup and the next segment continues bringing it to the lips from that same view. If the camera changes to a side angle or close-up, use `independent`.
- `tail_frame`: only when the ending composition is explicitly carried forward, such as the previous segment ending with the character on the right side of frame facing left with a letter raised, and the next segment beginning from that same composition before the character turns. “Same scene” or “related action” alone is insufficient.

## Small cases

### Same-scene camera change
The previous last sub-shot is a medium shot in a living room where the character puts down a phone. The current first sub-shot is a side close-up in the same room where the character looks up. Use `relation: same_scene_cut`, `mode: independent`, and `source_storyboard_id: null`. Explain that the camera changed; do not misclassify it as motion context.

### Continuous action from the same camera
The previous fixed medium shot shows a character reaching for a cup. The current segment begins from the same fixed medium shot while the hand is still rising, without replaying the action. Use `relation: continuous_action`, `mode: motion_context`, and the previous real ID only if `supported_modes` includes `motion_context`. Otherwise use `independent`, a `null` source, and `needs_review: true`.

### Explicit tail-frame carryover
The previous ending clearly establishes the character's placement, facing, and held object, and the current segment explicitly starts from that composition. Use `tail_frame` only when the capability list supports it; otherwise use independent generation and explain the missing capability.

### Scene or time change
The story cuts from a kitchen at night to a street in the morning, or jumps from that night to the next day in the same location. Use `scene_change` or `time_change` with `independent` and a `null` source. Do not carry a tail frame or motion context across the change.

### Insufficient evidence
The previous segment only says “he walks out,” while the current one says “he looks back,” without position, facing, camera, or time evidence. Use `relation: unknown`, `mode: independent`, a `null` source, and `needs_review: true`; record the missing evidence in `reason`.

### Dialogue bridge
Dialogue can support narrative continuity in `reason`, for example when a question and answer about the same event span two segments. This does not promise seamless audio, a J-cut, or any audio transition. Choose the mode from the visual relationship and do not call an export-transition tool.

## Save check

Call `saveContinuity` in batches of 1–8, covering every target exactly once. Each item must have this shape and use the current revision read from `readStoryboardContext`:

```json
{
  "storyboard_id": 123,
  "continuity_revision": 0,
  "continuity_plan": {
    "mode": "independent",
    "relation": "unknown",
    "source_storyboard_id": null,
    "reason": "Insufficient evidence; human review required",
    "needs_review": true,
    "start_state": "Review needed: …",
    "end_state": "Review needed: …"
  }
}
```

Do not add or alter manual choices, revisions, screenplay content, storyboard descriptions, video prompts, video files, or export transitions. The service preserves a manual choice; AI analysis may add only a suggestion. For an ordinary parameter error, follow the returned feedback, correct the request, and continue only with unsaved targets. For a revision conflict, stop this analysis run, tell the user to refresh and retry, preserve suggestions already saved successfully, and state that this run did not complete. Never fabricate success.