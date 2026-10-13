---
name: continuity-planner
description: 샷 연속성 판단을 위한 실용 규칙과 저장 제약
---

# 샷 연속성 분석 가이드

이 Skill은 `continuity_planner` 가 인접한 두 스토리보드 구간의 경계를 판단하도록 돕습니다. 근거의 우선순위, 보수적인 선택, 간단한 사례를 제공합니다. 작업 순서와 도구 순서는 System Prompt를 따릅니다.

## 판단 체크리스트

1. 두 스토리보드가 같은 에피소드에 속하고 현재 구간이 바로 앞 구간 다음인지 확인합니다. 출처는 같은 에피소드에서 바로 앞 구간의 실제 데이터베이스 `id` 만 사용할 수 있습니다. `shot_number` 를 쓰거나 구간을 건너뛰거나 에피소드를 넘지 않습니다.
2. 앞 구간의 마지막 서브 컷과 현재 구간의 첫 서브 컷만 비교합니다. 구간 내부의 컷 전환은 이 분석 대상이 아닙니다.
3. 비디오 기능을 선택하기 전에 화면 근거를 확인합니다. 기능은 `readStoryboardContext` 가 반환한 `video_model.supported_modes` 만 사용합니다.
4. 관계를 정한 뒤 모드를 정합니다.
   - 같은 장면에서 화면 크기, 앵글, 클로즈업, 리버스 샷이 바뀌면 보통 `same_scene_cut` + `independent` 입니다. 독립 생성의 source는 `null` 입니다.
   - 같은 카메라에서 경계를 넘어 동작이 분명히 이어질 때만 `continuous_action` + `motion_context` 를 사용하며 기능이 지원될 때만 선택합니다.
   - 앞 구간 끝의 구도, 인물 위치와 자세를 명확히 이어받을 때만 `tail_frame` 을 사용하며 기능이 지원될 때만 선택합니다.
   - 장면 변경은 `scene_change` + `independent`, 시간 변경은 `time_change` + `independent` 입니다. 둘 다 source는 `null` 입니다.
   - 근거가 불명확하거나 기능 목록이 비어 있으면 `unknown` + `independent`, `needs_review: true` 를 사용합니다.
5. 인물의 위치, 방향, 자세, 시선, 소지품, 동작 진행도, 카메라 위치를 확인합니다. 대본이나 `description` 에서 확인되는 사실만 씁니다. 중요한 근거가 없으면 검토 필요로 표시하고 상상해서 채우지 않으며 `needs_review: true` 로 합니다.
6. 첫 구간은 항상 `independent`, `source_storyboard_id: null` 입니다. 다른 에피소드의 구간을 source로 사용할 수 없습니다.

## 모드 경계

- `independent`: 일반 컷, 장면 또는 시간 변경, 관계 불명, 지원되지 않는 기능, 근거 부족에 사용하는 기본 보수 모드입니다.
- `motion_context`: 같은 카메라에서 이어지는 동작에만 사용합니다. 예를 들어 고정 미디엄 샷에서 인물이 컵에 손을 뻗고 다음 구간이 같은 화면에서 컵을 입으로 가져가는 동작을 이어가는 경우입니다. 카메라가 측면 앵글이나 클로즈업으로 바뀌면 `independent` 입니다.
- `tail_frame`: 끝 구도를 명시적으로 이어받을 때만 사용합니다. 예를 들어 앞 구간이 화면 오른쪽에 선 인물이 왼쪽을 향하고 편지를 든 모습으로 끝나며 다음 구간이 같은 구도에서 시작한 뒤 돌아서는 경우입니다. “같은 장면” 또는 “관련된 동작”만으로는 tail frame의 근거가 되지 않습니다.

## 간단한 사례

### 같은 장면에서 카메라 변경
앞 구간 마지막 서브 컷은 거실 미디엄 샷에서 인물이 전화를 내려놓는 장면이고, 현재 구간 첫 서브 컷은 같은 방의 측면 클로즈업에서 인물이 고개를 드는 장면입니다. `relation: same_scene_cut`, `mode: independent`, `source_storyboard_id: null` 로 하고 카메라가 바뀐 점을 이유에 씁니다. motion context로 오인하지 않습니다.

### 같은 카메라의 연속 동작
앞 구간의 고정 미디엄 샷에서 인물이 컵을 잡으려고 손을 뻗고, 현재 구간이 같은 고정 화면에서 손을 계속 들어 올리며 동작을 반복하지 않는 경우입니다. `supported_modes` 에 `motion_context` 가 있을 때만 `relation: continuous_action`, `mode: motion_context`, 앞 구간의 실제 ID를 사용합니다. 지원되지 않으면 `independent`, source `null`, `needs_review: true` 로 바꿉니다.

### 명확한 tail frame 이어받기
앞 구간 끝에 인물의 위치, 방향, 소지품이 명확한 구도로 제시되고 현재 구간이 그 구도에서 시작한다고 명시된 경우입니다. 기능 목록이 `tail_frame` 을 지원할 때만 선택하고, 지원하지 않으면 독립 생성으로 하며 기능 부족을 이유에 적습니다.

### 장면 또는 시간 변경
밤의 부엌에서 아침의 거리로 바뀌거나 같은 장소에서 그날 밤에서 다음 날로 시간이 건너뛰는 경우입니다. `scene_change` 또는 `time_change` 와 `independent`, source `null` 을 사용합니다. 변화 너머로 tail frame이나 motion context를 이어 붙이지 않습니다.

### 근거 부족
앞 구간에는 “밖으로 걸어 나간다”만 있고 현재 구간에는 “뒤돌아본다”만 있으며 위치, 방향, 카메라, 시간이 제시되지 않은 경우입니다. `relation: unknown`, `mode: independent`, source `null`, `needs_review: true` 로 하고 부족한 근거를 `reason` 에 적습니다.

### 대사 브리지
같은 사건에 대한 질문과 답이 구간을 넘어 이어지는 경우처럼, 대사를 `reason` 의 서사적 보조 근거로 사용할 수 있습니다. 하지만 오디오의 seamless 연결이나 J/L 컷을 보장한다는 뜻은 아닙니다. 화면 관계에 따라 모드를 정하고 내보내기 전환 도구는 호출하지 않습니다.

## 저장 점검

`saveContinuity` 는 1-8개씩 호출하고 모든 대상을 정확히 한 번씩 처리합니다. 각 항목은 다음 구조를 사용하며 `readStoryboardContext` 에서 읽은 현재 revision을 전달합니다.

```json
{
  "storyboard_id": 123,
  "continuity_revision": 0,
  "continuity_plan": {
    "mode": "independent",
    "relation": "unknown",
    "source_storyboard_id": null,
    "reason": "근거가 부족하여 검토 필요",
    "needs_review": true,
    "start_state": "검토 필요: …",
    "end_state": "검토 필요: …"
  }
}
```

수동 선택, revision, 대본, 스토리보드 설명, 비디오 프롬프트, 비디오 파일, 내보내기 전환을 추가하거나 변경하지 않습니다. 기존 수동 선택은 서비스가 보존하고 AI 분석은 suggestion만 추가합니다. 일반적인 인자 오류라면 반환된 피드백에 따라 수정하고 저장되지 않은 대상만 계속 처리합니다. revision 충돌이라면 이 분석 실행을 중지하고 새로 고친 뒤 다시 시도하라고 안내하며, 이미 성공적으로 저장된 제안은 보존하고 이번 실행이 완료되지 않았음을 분명히 말합니다. 성공을 꾸며내지 않습니다。