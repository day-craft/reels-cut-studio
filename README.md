# 릴스 컷 스튜디오 (reels-cut-studio)

수제공·말랑이 릴스 영상을 **아이폰 사파리에서 바로** 자르고, 배속하고, 색감과 자막을
넣어 저장하는 모바일 웹 편집기입니다. 서버 없이 브라우저 안에서만 동작하고, 영상은
기기 밖으로 나가지 않습니다.

- 라이브: https://day-craft.github.io/reels-cut-studio/
- 모든 처리는 클라이언트 사이드 (`<video>` + `<canvas>` + `MediaRecorder`)

## 되는 일

1. **구간 자르기 · 컷 빼기 · 순서 바꾸기**
   - 영상 여러 개를 한 번에 불러와 클립으로 이어 붙임 (`.mp4`, `.mov` 등)
   - 클립마다 시작·끝 슬라이더 + 재생 중 `현재 = 시작` / `현재 = 끝` 원탭
   - 둘로 나누기(분할), 복제, 삭제, 위/아래로 순서 변경, 되돌리기
   - 원본 비율 유지 (세로 9:16·가로 16:9·정사각). 비율이 섞이면 여백 처리
2. **구간별 배속**
   - 클립마다 `0.5x 0.75x 1x 1.2x 1.5x 2x` + 0.25~3.0x 미세 조정
   - 전체 예상 재생 시간 실시간 갱신, 소리는 원래 톤 유지(pitch 보존)
3. **색감 보정 · 자막**
   - 프리셋 `원본 / 화사하게 / 뽀얗게 / 선명하게` + 밝기·대비·채도·따뜻함 슬라이더
   - 자막: 문구(140자), 적용 범위(영상 전체 / 선택 클립), 보이는 구간(%), 위치
     (위/가운데/아래), 크기(작게/보통/크게), 글자색 4종, 반투명 배경 박스
   - 미리보기와 내보내기가 같은 캔버스 렌더러를 쓰므로 결과가 화면과 같음

## 내보내기

- `MediaRecorder`로 **MP4(H.264/AAC) 우선**, 안 되면 WebM으로 자동 폴백
- 실제 재생 속도로 녹화하므로 50초 영상은 약 50초 걸립니다 (진행률 %·남은 시간 표시, 취소 가능)
- 완료 후 미리보기 + `공유하기`(Web Share API, 사진첩 저장) + `저장하기`(`<a download>`)
- 오디오가 없는 영상도 에러 없이 처리 (오디오 트랙을 요구하지 않음)

## 아이폰 사용 팁

- 내보내는 동안 **화면을 끄거나 다른 앱으로 나가지 마세요.** (화면 꺼짐 방지 Wake Lock 요청은 시도하지만 사파리 정책에 따라 다름)
- 완성본은 `공유하기 → 사진에 저장`이 가장 간편합니다.
- 사파리는 배포 후 이전 `js`/`css`를 캐시합니다. 업데이트했는데 그대로면 `?v=N`을 올려 배포하세요.

## 구조

```
index.html            화면 마크업
styles.css            모바일 퍼스트 스타일 (safe-area, 100dvh, 44px 터치)
js/core/timeline.js   클립·타임라인 계산 (자르기/분할/순서/배속/총 길이)
js/core/color.js      프리셋, CSS filter 문자열, 픽셀 폴백
js/core/subtitles.js  자막 모델·구간·줄바꿈·레이아웃
js/core/render.js     캔버스 프레임 렌더러 (영상 + 색감 + 자막)
js/core/exporting.js  MIME 선택, 비트레이트, 진행률/ETA
js/core/media.js      캔버스 크기, 비율 맞춤, 오디오 트랙 판별
js/ui/player.js       실시간 미리보기 재생기
js/ui/exporter.js     캔버스 녹화 파이프라인
js/ui/app.js          화면 상태·이벤트·편집 동작
js/main.js            부트스트랩
test/                 node:test 단위 + jsdom 통합 테스트
tools/make_icons.py   PNG 아이콘 생성 (PIL)
```

### iOS Safari 호환성 메모

- GitHub Pages는 COOP/COEP 헤더를 줄 수 없어 `SharedArrayBuffer` 기반 ffmpeg.wasm은 쓸 수 없습니다. 그래서 캔버스 + `MediaRecorder` 방식을 씁니다.
- `ctx.filter`는 iOS 18 / Safari 18 이상에서 지원됩니다. 지원 여부를 런타임에 확인하고, 없으면 `getImageData`/`putImageData` 픽셀 보정으로 폴백합니다(느리지만 같은 결과).
- 한글·이모지 자막은 캔버스에 직접 그리므로 폰트 깨짐이 없습니다.
- 오디오는 Web Audio(`createMediaElementSource`)로 캡처하며, 내보내기 중에는 모니터 게인을 0으로 두어 스피커로 새지 않습니다.

## 개발

```bash
npm install          # jsdom (테스트용)
npm test             # 단위 + jsdom 통합 테스트
python3 -m http.server 8080   # 로컬 확인
```
