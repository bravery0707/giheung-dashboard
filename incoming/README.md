# 매물 엑셀 투입함

네이버 부동산에서 받은 힐스테이트 기흥 엑셀을 이 폴더에 정확히
`listings.xlsx`라는 이름으로 업로드하세요.

업로드 커밋이 끝나면 GitHub Actions의 **매물 엑셀 반영**이 자동으로 실행되어:

1. `data/listings.json`을 최신 매물로 교체하고
2. `data/listing-history.json`에 날짜별 스냅샷과 변동을 기록한 뒤
3. 현재 브랜치에서 원본 `incoming/listings.xlsx`를 제거합니다.

같은 날짜에 다시 올리면 그 날짜 스냅샷을 교체하며, 이중으로 기록하지 않습니다.
