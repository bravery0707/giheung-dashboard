# 힐스테이트 기흥 데이터랩

힐스테이트 기흥의 국토교통부 실거래와 날짜별 매물 관측을 비교하는 GitHub Pages 대시보드입니다.

- 요약·실거래·매물 현황·매물 추이·매물 변동
- 신규·소멸 후보·가격변동·재등장, 3·7·14일 미관측 필터
- 대표 매물 수와 중개소 광고 수 구분, 마지막 조사일·수집 상태 표시

## 자동 매물 갱신 상태

**연결부 준비 / 실제 제공처 미확보 / 자동 수집 비활성화.**

네이버 매물을 직접 가져오는 허가된 API나 피드는 아직 연결하지 않았습니다. 네이버 비공개 API 호출 또는 브라우저 스크래퍼가 구현된 상태가 아닙니다. 데이터 수집과 공개 범위를 확인한 뒤 제공처 어댑터를 연결해야 합니다.

[데이터 계약, 수집 경로 확인 결과, 활성화 절차와 14일 시험 계획](docs/listing-automation.md)

## 실거래 갱신

`.github/workflows/update-data.yml`은 매일 한국시간 **08:30**에 예약 실행됩니다. `DATA_GO_KR_KEY` Secret은 공공데이터포털 일반 인증키(Decoding)입니다. 인증키는 브라우저에 노출하지 않습니다.

필요 API: 아파트 매매 실거래가 상세 자료 15126468, 아파트 매매 실거래가 자료 15126469, 아파트 전월세 실거래가 자료 15126474.

## 기존 파일 반영

과거 조사자료는 실제 조사일을 지정해야 합니다. 파일의 매물 등록일은 조사일로 사용하지 않습니다.

```sh
node scripts/import-listings.mjs incoming/listings.xlsx --date 2026-09-01
node scripts/import-listings.mjs incoming/listings.json
```

JSON은 문서의 schemaVersion 2 형식을 사용합니다. 구형 JSON은 엑셀처럼 `--date`가 필요합니다. 같은 날짜 교체는 `--replace-date`를 명시합니다. 매물 수가 절반 미만으로 줄면 전체 수집 여부를 확인한 후에만 `--accept-count-drop`을 사용합니다.

GitHub 업로드 자동 반영:
- 엑셀은 `incoming/listings.xlsx`와 실제 조사일 한 줄을 담은 `incoming/listings.date.txt`를 함께 올립니다.
- JSON은 `incoming/listings.json`을 올립니다. JSON과 엑셀을 동시에 올리지 않습니다.
- 또는 Actions의 ‘매물 엑셀 반영’을 수동 실행하면서 조사일을 입력합니다.
- 성공하면 입력 파일을 현재 브랜치에서 제거합니다. **Git 이력에는 남으므로 공개 가능한 자료만 업로드해야 합니다.**

## Pages 배포

저장소 Settings → Pages → Source를 **GitHub Actions**로 설정합니다. 데이터 갱신 workflow 종료 후 별도의 `deploy-pages.yml`이 배포합니다. 기본 토큰의 데이터 커밋이 Pages 빌드를 유발하지 않는 제약을 처리합니다. 공개할 HTML·assets·데이터 JSON만 배포물에 포함합니다.

‘최신 데이터’ 버튼은 저장된 JSON을 다시 읽으며 네이버를 수집하지 않습니다.

## 검증과 로컬 실행

```sh
node --test tests/*.test.mjs
python -m http.server 8000
```

인공 데이터로 날짜·전체 수집 검증·가격변동·재등장·미관측·14일 이력 흐름을 검사합니다. 실제 네이버 수집 성공을 보증하는 테스트는 아닙니다.

매물은 광고 ID를 우선 추적합니다. ID가 없는 과거 자료는 속성에 의한 추정이며, 새로운 광고 ID로 재등록되면 같은 주택인지 확정할 수 없습니다. 매물 소멸은 거래 성사가 아닙니다.
