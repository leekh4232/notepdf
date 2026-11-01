# 변경 이력

이 프로젝트의 주요 변경 사항을 기록합니다.

형식은 [Keep a Changelog](https://keepachangelog.com/ko/1.1.0/)를, 버전은 [유의적 버전](https://semver.org/lang/ko/)을 따릅니다.

## [0.12.1] - 2026-11-01

### 변경
- Marketplace 배포 방식만 바꿨습니다. 확장의 기능과 설정은 0.12.0과 같습니다.

## [0.12.0] - 2026-11-01

### 추가
- **필기 영역 추가**: 별도 확장이던 PDF2Note를 이 확장에 합쳤습니다. `.pdf` · `.ipynb` · `.md`를 우클릭하고 **필기 영역 추가**(Add Note Area) 메뉴에서 고르면 페이지마다 줄노트 필기 영역과 머릿말 · 꼬릿말을 붙인 `원본이름_note.pdf`를 만듭니다. 가로 원본은 아래에, 세로 원본은 오른쪽에 붙고, 피드백 모드 · 용지 크기 지정 · 비밀번호 · `teacherMode` 명령 · 여러 파일 한꺼번에 처리도 그대로입니다. 이제 PDF2Note를 따로 설치하지 않아도 됩니다.
- 필기 영역 설정은 `ipynb-pdf-converter.note.*` 아래에 있습니다: `note.paperSize`(기본 `original`) · `note.layoutMode`(`note`) · `note.feedbackBannerImage`(비움) · `note.lineGap`(`18`) · `note.headerText`(`{file}`) · `note.footerText`(`{page} / {total}`) · `note.headerAlign`(`left`) · `note.footerAlign`(`right`) · `note.headerFooterFontSize`(`10`) · `note.outputFileName`(`{name}_note`). 저장 위치(`outputDirectory`) · `openAfterConvert` · `pdfPassword` · `pdfPermissions` · `ownerPassword` · `teacherMode`는 변환과 같은 설정을 씁니다.

### 변경
- **확장 이름을 NotePDF로 바꿨습니다.** 확장 ID(`leekh.ipynb-pdf-converter`)와 설정 이름은 그대로라 업데이트만 하면 됩니다. 출력 창 이름도 NotePDF입니다.
- GitHub 저장소를 [leekh4232/notepdf](https://github.com/leekh4232/notepdf)로, 소개 페이지를 [notepdf.hossam.kr](https://notepdf.hossam.kr/)로 옮겼습니다.

### 제거
- 다른 확장용 API `convertToPdfBytes`를 없앴습니다. PDF2Note만 쓰던 API입니다.

## [0.11.0] - 2026-11-01

### 추가
- **여러 파일 한꺼번에 변환**: 탐색기에서 `.ipynb` · `.md` 파일을 두 개 이상 선택하고 변환 명령을 실행하면 선택한 파일을 모두 차례로 변환합니다. 지원하지 않는 확장자는 건너뜁니다. 끝나면 "N개 중 M개 변환" 요약 알림 하나만 띄우고, 실패나 이미지 누락이 있으면 **Show Log**로 확인할 수 있습니다. 진행 중 취소하면 남은 파일은 변환하지 않습니다.
- **비밀번호는 한 번만 입력**: (비밀번호) 명령으로 여러 파일을 변환하면 비밀번호를 한 번만 묻고 모든 PDF에 같은 비밀번호를 겁니다. `pdfPassword`가 설정돼 있으면 묻지 않고 그 값을 모든 파일에 씁니다.

## [0.10.5] - 2026-10-27

### 변경
- **우클릭 메뉴를 하위 메뉴 하나로 묶었습니다.** 탐색기 · 에디터 탭 · 편집기 본문 · 노트북 셀 메뉴에 변환 명령이 최대 6개씩 펼쳐지던 것을 **PDF로 변환**(Convert to PDF) 항목 하나로 줄이고, 그 안에 기본 명령과 `teacherMode` 명령을 구분선으로 나눠 넣었습니다. 명령 팔레트는 그대로입니다.

## [0.10.4] - 2026-10-26

### 수정
- **SVG 그림이 확대 · 절단되어 찍히던 문제를 고쳤습니다.** `width` · `height` 없이 `viewBox`만 있는 SVG 파일(`![](그림.svg)`)이 PDF에서 상자 크기는 맞지만 그림 일부만 크게 확대되어 보이던 문제입니다. 이제 모든 SVG(파일 · 셀 출력 · 문서 안의 `<svg>`)를 캡처 직전에 화면에 배치된 크기와 페이지 해상도로 PNG로 그려 넣어, 원본 크기 표기 방식과 상관없이 보이는 그대로 들어갑니다.

## [0.10.3] - 2026-10-26

### 추가
- **자동 업데이트 안내**: VS Code의 확장 자동 업데이트가 꺼져 있으면(`extensions.autoUpdate`가 `off`/`false` 또는 `onlySelectedExtensions`), 설치 뒤 처음 한 번 켤지 묻고 **Turn on auto-update**를 누르면 사용자 설정을 켭니다. 이미 켜져 있으면 아무것도 묻지 않습니다. 자동 업데이트 여부는 VS Code 사용자 설정이라 확장이 직접 켤 수는 없습니다.

## [0.10.2] - 2026-10-26

### 수정
- **큰 SVG가 페이지를 벗어나지 않습니다.** 셀 출력의 SVG 그림(matplotlib `svg` 백엔드, graphviz 등)과 HTML 출력 · 마크다운 안의 `<svg>` · `<img>`가 원본 크기로 찍혀 오른쪽이 잘리던 문제를 고쳤습니다. 이제 내용 폭보다 넓은 그림은 비율을 유지한 채 폭에 맞춰 줄어듭니다.

## [0.10.1] - 2026-10-26

### 변경
- **`.md`의 머리글(YAML front matter)을 PDF에서 뺍니다.** 맨 위의 `theme` · `title` · `layout` 블록과 Slidev 슬라이드 중간의 `---` / `layout: two-cols` / `---` 같은 블록이 더 이상 가로줄과 문단으로 찍히지 않습니다. 코드 블록 안의 예시와 내용 사이의 일반 `---` 구분선은 그대로 남습니다. PDF2Note로 `.md`에 필기 영역을 붙일 때도 같습니다.

## [0.10.0] - 2026-10-26

### 추가
- **PDF 텍스트 선택 · 복사 · 검색**: 페이지 그림 위에 보이지 않는 텍스트 층을 겹쳐, 생성된 PDF에서 글자를 드래그해 복사하고 PDF 뷰어에서 검색할 수 있습니다. 코드 셀의 들여쓰기와 머릿말 · 꼬릿말 글자도 포함됩니다. 한글은 내장 NanumGothic 글꼴에서 쓰인 글자만 넣어 PDF 크기가 거의 늘지 않습니다. 이 PDF를 받아 쓰는 PDF2Note 결과에도 텍스트가 그대로 남습니다.

### 변경
- **PDF 조립을 pdf-lib로 바꿨습니다.** 비밀번호를 걸면 PDF가 **AES-256**으로 암호화됩니다.

## [0.9.3] - 2026-10-26

### 변경
- README 배지 아래에 소개 페이지 링크를 넣었습니다.

## [0.9.2] - 2026-10-26

### 변경
- 홈페이지 주소를 소개 페이지 https://ipynb-to-pdf.hossam.kr/ 로 옮겼습니다.

## [0.9.1] - 2026-10-26

### 변경
- **`ownerPassword`가 비어 있으면 PDF 비밀번호를 그대로 씁니다** (`pdfPassword` 설정값 또는 팝업에 입력한 값). 전에는 무작위 값이었습니다. 이제 작성자가 언제든 권한 제한을 풀 수 있고, 그 비밀번호를 아는 사람도 소유자 권한을 얻습니다.

## [0.9.0] - 2026-10-26

### 추가
- **확장 API** `convertToPdfBytes` (`activate`의 반환값): PDF2Note 같은 다른 확장이 같은 변환 과정을 거친 PDF 바이트를 받아 갑니다.
- **`pdfPageSize`에 태블릿 규격 추가**: iPad Pro 13"/11", iPad Air 13", iPad · iPad Air 11", iPad mini, Galaxy Tab S11 11", Galaxy Tab S11 Ultra · S12 Ultra (화면이 같은 기종은 한 항목으로 묶음). 페이지 크기는 기기 화면의 논리 크기(CSS px)입니다.

### 변경
- **`pageBreakBefore` 기본값을 `none`으로** 바꿨습니다 (h1 제목 앞에서 페이지를 나누지 않음). `h1`과 `h1-h2`는 그대로 고를 수 있습니다.

### 수정
- 완료 경고나 오류 메시지를 닫을 때까지 진행률 알림이 사라지지 않던 문제.

## [0.8.0] - 2026-10-25

### 추가
- **설정을 중요도순으로 정리**하고 27개를 새로 넣었습니다.
  - 출력 파일: `outputDirectory`, `outputFileName` (`{name}`, `{date}`), `openAfterConvert`.
  - 머릿말 · 꼬릿말: `headerText`, `footerText` (`{file}`, `{date}`, `{page}`, `{total}`, 비우면 표시 안 함), `headerAlign`, `footerAlign`, `headerFooterFontSize`.
  - 페이지 나누기: `pageBreakBefore` (`h1` | `h1-h2` | `none`), `breakBeforeTags`.
  - 내용 선택: `hideCodeCells`, `hideOutputs`, `excludeCellTags`.
  - 모양: `tableNowrap` (`first` | `all` | `none`), `showLineNumbers` (`auto` | `on` | `off`), `baseFontSize`, `bodyFontFamily`, `codeFontFamily`.
  - 크기: `imageFormat` (`png` | `jpeg`), `jpegQuality`.
  - 보안: `pdfPermissions` (print/copy/modify/annot-forms), `ownerPassword`.
  - 표지 · 워터마크: `coverPage`, `coverTitle`, `coverSubtitle`, `coverAuthor`, `watermarkImage`, `watermarkWidth`.
  - 고급: `allowRemoteImages`, `renderTimeoutSeconds`.
- 변환할 때마다 출력 창이 열리지 않습니다. 오류 알림과 "이미지 누락" 경고의 *Show Log* 버튼으로 엽니다.
- **진행률 알림**: 진행 막대, 단계 메시지(렌더링, 묶음 n/m 캡처, 조립, 저장), 취소 버튼. 변환 화면을 닫아도 취소됩니다.
- **덮어쓰지 않음**: 같은 이름의 PDF가 있으면 `이름 (1).pdf`, `이름 (2).pdf`처럼 저장합니다.
- **한글 UI**: 명령 이름과 모든 설정 설명을 `package.nls.json`(영어)과 `package.nls.ko.json`(한글)으로 제공합니다. VS Code 표시 언어에 맞는 쪽이 보입니다.
- **편집기 본문과 노트북 셀의 우클릭 메뉴**(`editor/context`, `notebook/cell/title`)에도 탐색기 · 탭 메뉴와 같은 변환 명령이 있습니다.
- **teacher mode** (`teacherMode`, 마지막 설정): 우클릭 메뉴와 명령 팔레트에 `(hossam)` / `(jussam)` 변환 명령을 비밀번호 유무별로 추가합니다. `nb_convert.py --ssam`처럼 강사 마크(`itwill-ho.png` / `itwill-ju.png`, 폭 100 px)를 모든 페이지 우측 상단에 `headerText` 대신 그립니다.

### 수정
- **기본 배율 3에서 긴 노트북이 빈 페이지(머릿말 · 꼬릿말만)로 나오던 문제**: 열 쪽쯤 넘으면 캡처 캔버스가 Chromium의 높이 한계 32,767 px를 넘었고, html2canvas가 빈 그림을 조용히 돌려줬습니다. 이제 페이지 경계에 맞춘 최대 16,000 px 묶음으로 나눠 캡처합니다.
- **`default` 페이지 테마에서 페이지 경계가 밀리던 문제**: html2canvas가 github-markdown.css의 clearfix 의사 요소를 그려서, 캡처된 마크다운 셀이 페이지 계산 때보다 40 px씩 길었습니다. 그 의사 요소를 껐습니다.
- **Markdown Reader 테마에서 목록 기호가 글자에 붙던 문제** (`•이 함수는`): `letter-spacing`이 0이 아니면 html2canvas가 기호 위치를 잘못 잡아서, 목록 항목은 MDR의 0.2 px 대신 0을 씁니다.
- **마크다운 안 HTML 상자(예: `<div style="padding…">` 피드백 상자) 위쪽 여백이 너무 크던 문제**: 상자를 여는 제목이 상자 안 여백에 더해 문서용 위 여백 35 px를 유지했습니다. 이런 상자의 첫 · 마지막 자식은 바깥 여백을 없애 노트북 화면과 같게 했습니다.

## [0.7.1] - 2026-10-23

### 추가
- **확장 아이콘** (`media/icon.png`, 원본 `media/icon.svg`): 코드 셀이 있는 노트북 페이지가 PDF가 되는 그림.

### 수정
- **마크다운 파일(과 노트북 마크다운 셀)이 참조하는 이미지가 PDF에서 빠지던 문제**: 웹뷰는 확장의 media 폴더만 읽을 수 있어 `<img src>` 경로가 열리지 않았습니다. 이제 참조된 이미지(상대 · 절대 경로, `file:` · `http(s)` URL)를 렌더링 전에 `data:` URL로 넣고, 노트북 셀의 `attachment:` 이미지도 처리합니다. 읽지 못한 이미지는 출력 창에 경고로 남깁니다.

## [0.7.0] - 2026-10-23

`nb_convert.py`와 결과를 맞췄습니다.

### 추가
- **`pdfTheme` 설정** (`default` | `light` | `dark`, 기본값 `light`): `nb_convert.py --theme`의 페이지 테마를 옮겼습니다. `light` · `dark`는 Markdown Reader 팔레트(`media/page-themes/mdr.css`, 스크립트의 `MDR_CSS` 그대로)를 쓰고, `default`는 GitHub 모양입니다. 코드 셀은 계속 `codeTheme`을 따르며, `leekh` 꾸밈은 `default`에서만 적용됩니다.
- **`pdfPageSize` · `pdfPageOrientation` 설정**: A3, A4(기본), A5, B4 · B5(JIS), Letter, Legal, 16:9 와이드 슬라이드(스크립트의 가로 모드), 세로 또는 가로. 96 dpi로 배치해 PDF의 실제 크기가 정확합니다.
- **`pdfPassword` 설정**과 두 번째 명령 **"노트북/마크다운을 PDF로 변환 (비밀번호)"** (우클릭 메뉴와 명령 팔레트). 설정한 비밀번호로 암호화하고, 비어 있으면 입력받습니다. 권한은 `secure_pdf_with_pikepdf`와 같아서 주석 · 양식만 허용하고 인쇄 · 복사 · 수정은 막습니다. 일반 변환 명령은 암호화하지 않습니다.
- **`mdr-dark` / `mdr-light` 코드 테마** (기본값 `mdr-dark`): `nb_convert.py --code-theme`의 Markdown Reader One Dark/Light 팔레트.
- **WeasyPrint 같은 페이지 나누기**: 글줄 · 표 행 · 그림 중간에서 자르지 않고, 제목은 다음 내용과 같은 페이지에 둡니다. 첫 번째 다음의 모든 `h1`은 새 페이지에서 시작합니다 (`h1:not(:first-of-type) { break-before: page }`).
- 출력(stream, 결과, 트레이스백)의 **ANSI 색**을 지우지 않고 ansi2html 팔레트로 그립니다.
- **머릿말 · 꼬릿말**: 모든 페이지 우측 상단에 파일명(확장자 제외), 우측 하단에 `쪽 / 전체`를 10 px 회색으로 여백 띠 가운데에 넣습니다. 웹뷰에서 그리므로 한글 파일명도 그대로 나옵니다.

### 변경
- **`light` · `dark` 페이지 테마가 `nb_convert.py`의 세로(A4) 레이아웃을 그대로 재현합니다**: Helvetica Neue + Noto Sans CJK KR 본문, `.9em` 글자, 줄 번호 없는 코드 셀(Menlo 12.24 px, 둥근 상자, 20 px 여백), 촘촘한 출력 상자(11.56 px, 줄 간격 1.1, 왼쪽 강조선 4 px), 첫 열이 굵고 줄무늬가 있는 전체 폭 표, 가운데 정렬 그림, 이어진 텍스트 출력을 빈 줄 하나로 합친 상자(`nbconvert --to markdown` + pandoc과 같음).
- **`pdfPageMargin` 기본값을 `48`로** (0.5 in, 스크립트의 `@page` 여백). Markdown Reader 테마는 그 안에 스크립트의 본문 여백 30 px를 더합니다: 모든 페이지 좌우, 첫 페이지 위, 마지막 페이지 아래.
- dark 페이지 테마는 여백까지 종이 색으로 칠합니다.

### 수정
- **표 테두리가 `nb_convert.py`보다 두껍게(겹쳐) 그려지던 문제**: html2canvas는 `border-collapse`를 지원하지 않아 셀마다 공유 변에 테두리를 그렸습니다. 이제 모든 테마가 한쪽 테두리만으로 1 px 격자를 만듭니다.

### 제거
- **`pdfPageWidth` / `pdfPageHeight`** (CSS px). `pdfPageSize` + `pdfPageOrientation`을 쓰세요. Galaxy Tab 프리셋도 없앴습니다.

## [0.5.0] - 2026-05-22

### 추가
- **마크다운(`.md`) 지원**: 두 명령 모두 `.ipynb`뿐 아니라 `.md` 파일도 PNG/PDF로 변환합니다. 우클릭 메뉴, 명령 팔레트, 활성 편집기 모두 `.md`를 인식합니다.
- **`leekh` 코드 테마**: `nb_convert.py` 세로 모드에서 옮긴 밝은 A4 인쇄 스타일. 이모지가 붙은 색 제목(📚📘📝✏️📄), 왼쪽 강조선이 있는 밝은 코드 · 출력 상자, 첫 열이 굵은 GitHub 스타일 표. `ipynb-to-png-converter.codeTheme`에서 고릅니다.

### 변경
- 마크다운 지원에 맞춰 명령 이름을 **"Convert Notebook/Markdown to PNG/PDF"**로 바꿨습니다.

## [0.4.1] - 2026-05-21

### 추가
- **`pdfPageMargin` 설정** (기본값 `32` CSS px): 모든 PDF 페이지의 네 변에 안쪽 여백을 둡니다. 내용은 `페이지 폭 - 2×여백` × `페이지 높이 - 2×여백` 영역에 그려 가운데 놓습니다.

### 변경
- **`imageWidth` 기본값을 `960` → `800`으로** 낮춰 PNG와 PDF가 기본으로 같은 폭으로 렌더링되게 했습니다.

## [0.4.0] - 2026-05-21

### 추가
- **여러 페이지 PDF**: 캡처한 노트북을 일정한 크기의 페이지로 잘라, 일반 PDF 뷰어에서 한 장씩 넘겨 볼 수 있습니다.
- **PNG와 PDF의 폭 설정 분리**:
  - `pdfPageWidth` (기본값 `800`): PDF 페이지 폭(CSS px).
  - `pdfPageHeight` (기본값 `1280`): PDF 페이지 높이(CSS px).
  - 기본값은 **Galaxy Tab S9 세로**(800 × 1280 CSS px, 기기 2배 DPR에서 1600 × 2560 px)에 맞췄습니다.
- PDF 변환 때 출력 창에 페이지 수를 표시합니다.

### 변경
- `imageWidth`는 PNG 전용입니다. PDF는 `pdfPageWidth` / `pdfPageHeight`를 씁니다.
- 웹뷰 스크립트가 페이지별 data URL 배열을 만듭니다. PNG는 한 장짜리 배열을 돌려줍니다(PNG 결과는 그대로).

## [0.3.0] - 2026-05-21

### 추가
- **PDF 내보내기**: 새 명령 `Convert Jupyter Notebook to PDF`를 탐색기 우클릭 메뉴, 편집기 탭 메뉴, 명령 팔레트에서 쓸 수 있습니다. PNG와 같은 렌더링 결과를 PDF로 저장합니다.
- GitHub Actions 워크플로(`.github/workflows/build-and-publish.yml`): `main`에 push한 커밋 메시지에 `build`가 있으면 린트, 타입 검사, 번들, 패키징을 거쳐 VS Code Marketplace에 자동 배포합니다. `.vsix`를 워크플로 결과물로 올리고 태그가 달린 GitHub 릴리스도 만듭니다.
- 로컬 `vsce` 실행용 `npm run package` / `npm run publish`.

### 변경
- **스마트폰에 맞춘 기본 폭**: `imageWidth` 기본값을 `1024`에서 `360`(Galaxy S25 논리 폭)으로 낮췄습니다. 기본 `deviceScaleFactor` `3`과 함께 PNG 폭이 1080 px로, Galaxy S25 화면의 실제 픽셀 폭과 같습니다.
- **esbuild 번들 배포**: 확장 코드를 압축된 `out/extension.js` 하나로 묶습니다. `.vsix`에서 `node_modules`를 빼서 설치 크기가 크게 줄었습니다(v0.2.0은 node_modules만 약 79 MB).
- `vscode:prepublish`가 단순 `tsc` 대신 `vendor → typecheck → build`를 실행합니다.

### 제거
- `tsc`가 파일마다 만들던 `out/`의 JS (esbuild 번들 하나로 대체).

## [0.1.0] - 2026-05-21

### 변경
- **구조를 완전히 새로 짰습니다**: Python, nbconvert, Playwright, Chromium 의존성을 없앴습니다. 변환은 VS Code 내장 웹뷰와 html2canvas로 TypeScript 안에서만 이뤄집니다. 외부 런타임을 설치할 필요가 없습니다.
- 가독성을 위해 코드 셀 글자 크기를 14px로 키웠습니다.
- 깔끔한 모양을 위해 `In[N]:` / `Out[N]:` 프롬프트를 없앴습니다.

### 추가
- `codeTheme` 설정: 코드 하이라이트 테마 선택. Dracula(기본), GitHub Light, GitHub Dark, Atom One Light, Atom One Dark, Monokai, Nord, Visual Studio Dark.
- `imageWidth` 설정: 생성할 PNG 폭(480–2400 px).
- 소스 코드 셀 줄 번호.
- 텍스트 셀을 GitHub 스타일 마크다운으로 렌더링(`github-markdown-css`).
- 탐색기 사이드바 외에 편집기 탭 우클릭 메뉴와 명령 팔레트 항목.
- 파일을 지정하지 않고 명령을 실행하면(예: 명령 팔레트) 활성 노트북 편집기를 자동으로 찾습니다.

### 제거
- Python 스크립트 (`ipynb_to_png.py`, `python_scripts/convert.py`).
- `child-process-promise` npm 의존성.

### 수정
- `.vscodeignore`가 더는 `node_modules`를 빼지 않아 실행 의존성이 `.vsix`에 들어갑니다.
- 활성화 전에 빌드 결과물(`out/`)이 확실히 만들어집니다.

## [0.0.1] - 2026-05-20

### 추가
- Jupyter to PNG Converter 첫 배포.
- .ipynb 파일을 고품질 PNG 이미지로 변환.
- VS Code 탐색기 우클릭 메뉴.
- 이미지 해상도용 장치 배율(1-5) 설정.
- 사용자 지정 뷰포트 설정.
- 임시 파일 자동 정리.
- 변환 진행 상황과 오류를 보여 주는 출력 창.

### 기능
- nbconvert로 HTML 변환.
- Playwright 기반 화면 캡처.
- 내용 높이에 맞춘 뷰포트 조정.
- 실시간 상태 메시지와 알림.
