# 벳센타일 인스타그램 자동 게시

아임웹 등록순으로 컬렉션 피드를 만들고, 승인한 게시물만 예약 시간에 자동으로 올립니다.

## 전체 흐름

1. `data/collections.json`: 아임웹 엑셀에서 만든 게시 순서 (최신 등록순, 품절 제외)
2. `posts/<컬렉션>/source.json`: 사용할 원본 이미지와 캡션 지정
3. `node scripts/render-post.mjs <컬렉션>`: 슬라이드를 만들고 `draft`로 저장
4. 슬라이드와 캡션 검수 후 `post.json`을 수정: `status`를 `approved`로, `scheduled_at`에 예약 시간 입력
5. GitHub Actions가 30분마다 확인해 예약 시간이 지난 승인 게시물을 1회 실행당 1건 게시

`scheduled_at` 형식은 `2026-11-10T10:00:00+09:00`입니다.
슬라이드를 다시 만들면 `draft`로 돌아가므로 다시 승인해야 합니다.

## 처음 한 번만 하는 설정

토큰과 비밀번호는 채팅이나 파일에 적지 말고, 아래 GitHub Secrets에만 넣어 주세요.

### 1. 인스타 계정 전환
인스타그램 앱의 설정에서 계정 유형을 확인하고, 개인 계정이면 프로페셔널(비즈니스) 계정으로 전환합니다.

### 2. Meta 앱 만들기 (통합 로그인)
1. [Meta for Developers](https://developers.facebook.com/)에서 앱을 만들고 이용 사례 `Instagram에서 메시지 및 콘텐츠 관리`를 추가합니다.
2. 앱에 비즈니스 포트폴리오를 연결합니다. 통합 로그인 설정에 필요합니다.
3. `API setup with Unified login`에서 새 설정을 만듭니다. 게시에는 `instagram_basic`, `instagram_content_publish` 권한이 필요합니다.
4. `bathtileco`를 Instagram 테스터로 초대하고, Instagram 웹의 설정에서 수락합니다.
5. 토큰을 생성합니다. 토큰은 한 번만 표시됩니다.
6. `GET /me/assigned_instagram_accounts?fields=id,username`으로 Instagram 사용자 ID를 확인합니다.

### 3. GitHub 저장소
1. 공개(Public) 저장소를 만들고 이 폴더를 올립니다. Instagram이 이미지를 공개 URL로 가져가기 때문입니다.
2. 저장소의 Settings > Secrets and variables > Actions에 아래 값을 등록합니다.

| 이름 | 값 |
|---|---|
| `IG_ACCESS_TOKEN` | 2번에서 발급한 토큰 |
| `IG_USER_ID` | Instagram 사용자 ID |

### 4. 첫 게시 확인
테스트 게시물 1건을 승인하고 Actions의 `Publish due Instagram post`를 수동 실행합니다.

## 문제가 생기면

- `status`가 `needs_check`: 게시 단계에서 오류가 났지만 실제로 올라갔을 수도 있습니다. 중복 방지를 위해 자동 재시도하지 않으니, 인스타에서 확인한 뒤 올라가지 않았다면 `approved`로 되돌립니다.
- GitHub 예약 실행은 몇 분 이상 늦어질 수 있습니다.

## 제작 규칙

- 타일 색상은 보정하지 않습니다. 회전, 크롭, 배치만 합니다.
- 단독 타일 이미지는 색을 홈페이지 대표 이미지와 대조합니다. Arenite Stripe의 `-ex`는 일반 타일과의 조합 이미지이므로 단독 컬러 소개에 쓰지 않습니다.
- 규격, 마감, 포장, 색상은 아임웹 데이터에서 가져오며, 품절 제품이 있으면 제작이 중단됩니다.
- 시공 패턴 합성 이미지는 넣지 않습니다.
- 폰트는 페이퍼로지, 회사 표기는 B&T 로고를 씁니다. 밝은 배경에는 검정, 어두운 배경에는 흰색을 사용합니다.

## 엑셀 갱신

```bash
node scripts/import-imweb.mjs "<상품_전체.xlsx>" "<상품_상품정보수정용.xlsx>"
```

```bash
node scripts/build-collections.mjs
```

## 테스트

```bash
npm test
```
