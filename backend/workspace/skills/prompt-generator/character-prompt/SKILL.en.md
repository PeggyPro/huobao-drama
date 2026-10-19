---
name: character-prompt
description: Final character prompt specification — front-face close-up + three-view turnaround (front / 90-degree side / back), plus expression, costume/prop breakdown, and color palette as the appearance anchor for all subsequent generation
---

# Final Character Prompt (character sheet: front-face close-up + expressions/costume breakdown + three-view turnaround)

Generate one horizontal character reference sheet, not a single character portrait. The identity anchor is mandatory: a front-face close-up on the left and three equal-height full-body views on the right, showing front, 90-degree side, and back. Place the extension modules in the center and lower areas of the sheet without crowding or removing the three views.

## Layout and Content Modules

Use a clear horizontal archive layout whenever possible:

- **Left: main portrait/front-face close-up** — a frontal head-and-shoulders close view with clearly visible facial features, hairstyle, and skin texture; this is the facial identity anchor
- **Center: 6 expressions** — calm, smiling, angry, surprised, sad, and focused; all six expressions must be the same face, changing only expression and bearing
- **Center or lower area: costume and prop breakdown** — show local details of clothing, hairstyle ornaments, accessories, and the character's signature props; the design must match the main character and the three views, with no undeclared objects
- **Right: front, 90-degree side, and back turnaround** — three equal-height full-body views of the same character side by side, with the tops of the heads and soles aligned and the front/back clothing structure visible
- **Bottom: color palette strip** — extract five coordinated color blocks from the character's actual hair, skin, clothing, and accessories; do not use unrelated decorative colors

If space is limited, preserve the character facts, facial identity, hairstyle, clothing consistency, and complete three-view turnaround first, then reduce the information density of the expressions and breakdown modules. Do not remove the front-face close-up or the three views.

## Output Structure (assemble one coherent passage in the session language)

```
Horizontal character reference sheet: a front-face main portrait on the left, six expressions and costume/prop detail breakdowns in the center, three equal-height full-body views showing front, 90-degree side, and back on the right, and a five-color palette extracted from the character's actual appearance at the bottom;
all modules show the same character, the three full-body views are fully in frame, neutral A-pose, equal in height and aligned at the top of the head and the soles of the feet;
[age impression + gender impression + physique], [facial features], [hairstyle], [clothing + accessories + signature props];
the face, hairstyle, clothing, and props in the close-up, six expressions, costume/prop breakdown, and three full-body views are completely identical;
pure white background, soft even lighting, cinematic quality
```

## Description Order Rules

Put the **most recognizable features first**, covering every key element of `appearance` and `styling` in this order without omissions and without replacing the character facts with a template example:

1. Identity anchors: age impression, gender impression, and physique (height, build, and habitual posture)
2. Facial features: face shape, eyes, nose, mouth, and other notable features (scars, moles, glasses, etc.); the front-face close-up depends especially on this description
3. Hairstyle: color, length, and style
4. Clothing: style, color, material, condition, and structural details that can be verified from front and back views
5. Accessories and props: include only recognizable items present in the character description; do not pile them on or invent new ones
6. Visible bearing and expression: convert personality traits into visible eyes, expression, stance, and physical condition (for example, "haggard" → "weary eyes and slightly slumped shoulders"); do not pile up abstract personality words

The original character description has the highest priority. Do not change the age, gender, physique, facial features, hairstyle, clothing, accessories, or props. If a detail is not provided, keep it neutral and concise instead of inventing a strongly identifying trait.

## Composition and Consistency

- Left front-face close-up: face the camera directly with a neutral expression; head to shoulders fully in frame
- Center six expressions: calm, smiling, angry, surprised, sad, and focused; facial proportions, face shape, hairstyle, and clothing remain unchanged, with only expression and bearing changing
- Right three full-body views: front, 90-degree side, and back of the same character, **equal in height, side by side, evenly spaced**, with the tops of the heads and soles on the same horizontal lines
- The close-up, expressions, costume/prop breakdown, and three full-body views must have the same face, hairstyle, clothing, and prop set — explicitly state that "the face, hairstyle, clothing, and props in all modules are completely identical"
- Use a neutral A-pose and natural expression in the turnaround; do not use dynamic poses, so the sheet remains reusable as a reference anchor for later images and videos
- The costume and prop breakdown may explain only the character's existing design; it must not create a second outfit, extra accessories, or another person
- The palette strip must come from the character's actual appearance and contain exactly five coordinated color blocks, not random decorative colors
- Use soft, even studio lighting without dramatic shadows; the reference sheet must work across different scenes
- Use the target language specified by the session language directive and do not mix in unrelated vocabulary

## Prohibitions

- Dynamic poses, exaggerated expressions, props held in the hands in the turnaround, other people, or newly added characters
- Cropped bodies (full-body views must show the head to the soles completely; the close-up must show the head and shoulders completely)
- Changing the character facts, face shape, hairstyle, clothing, props, or the source of the palette without instruction
- By default, no text, titles, labels, numbers, watermarks, signatures, or social account marks; generate layout text only when the user explicitly requests it
- Player icons, play buttons, video progress bars, subtitle overlays, extra borders, or interface elements
- Heavy shadows, colored background lighting, background props, random decorations, or color blocks unrelated to the character

## Saving

Call `save_character_final_prompt`: the prompt parameter must contain no style words — **the project's visual style is automatically injected at the front of the final prompt**. Save one coherent final prompt, not only a module list or analysis.
