# 매물 엑셀 투입함

공개 가능한 힐스테이트 기흥 조사자료만 올리세요. 엑셀은 `listings.xlsx`와
실제 조사일(예: `2026-09-01`) 한 줄을 적은 `listings.date.txt`를 함께 올립니다.
등록일을 조사일로 추정하지 않습니다. 또는 Action 수동 실행에서 조사일을 지정합니다.

자동 피드와 같은 schemaVersion 2 JSON은 `listings.json`으로 올립니다.
JSON과 엑셀을 동시에 올리지 않습니다. [데이터 계약](../docs/listing-automation.md)을 참고하세요.

업로드 커밋이 끝나면 GitHub Actions의 **매물 엑셀 반영**이 자동으로 실행되어:

1. `data/listings.json`을 최신 매물로 교체하고
2. `data/listing-history.json`에 날짜별 스냅샷과 변동을 기록한 뒤
3. 현재 브랜치에서 원본 `incoming/listings.xlsx`를 제거합니다.

같은 날짜를 다시 올리면 기본적으로 거절합니다. 교체가 맞으면 Action 수동 실행의
‘같은 조사일 교체’를 선택합니다. 건수 급감은 전체 수집 여부를 확인한 후 승인합니다.

현재 브랜치에서 제거한 원본도 Git 이력에는 남습니다. 비공개 정보는 업로드하지 마세요.
