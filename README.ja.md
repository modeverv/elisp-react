# elisp-react

Emacs Lisp で書いた React です。

これは実験です。2013年ごろの React（props と state を持つコンポーネント、仮想 DOM を返す render 関数、差分計算）を Emacs Lisp で書いて、本物の Web ページを動かせるかを確かめます。GNU Emacs 30.2 がページの中で WebAssembly として動きます（[wasmacs](https://github.com/modeverv/wasmacs)）。コンポーネント、state、差分計算はすべて Emacs Lisp で、JavaScript は Lisp が計算した DOM 操作を適用するだけです。

公開ページ: <https://modeverv.github.io/elisp-react/> （サンプルを最初に開くとき、Emacs 本体を約5MBダウンロードします。以後はブラウザに保存され、2回目からは約0.2秒で描画されます）

これでできること:

- **プログラムが Emacs Lisp の Web ページ。** HTML ファイルの隣に `.el` ファイルを置くだけです。ビルドもバンドラも Node.js も要りません。ファイルを書き換えてリロードすれば反映されます。
- **全部が Emacs Lisp のアプリケーション。** ネイティブの Emacs を Web サーバーにすると（[両側が Emacs](#両側が-emacs)）、サーバーも、ページも、両者が共有するコードも Emacs Lisp になり、やり取りするのも Lisp のデータになります。必要なのは Emacs とブラウザだけです。
- **自分の Emacs の中身を見る画面。** 普段使っている Emacs の中でそのサーバーを起動すれば、バッファ一覧など Emacs が知っていることを、同じ言語で書いたページに表示できます。

[English](README.md)

## ページの書き方

```html
<div id="app">Loading Emacs…</div>
<script type="text/emacs-lisp" src="counter.el"></script>
<script type="module" src="https://modeverv.github.io/elisp-react/js/elisp-react.js"></script>
```

```elisp
;;; counter.el  -*- lexical-binding: t; -*-

(react-define-component 'counter
  :initial-state (lambda (props) (list :count (or (plist-get props :start) 0)))
  :render
  (lambda (self)
    `(div (:class "counter")
       (p () ,(format "Count: %d" (react-state self :count)))
       (button (:on-click ,(lambda (_event)
                             (react-set-state self :count (1+ (react-state self :count)))))
         "+1"))))

(react-mount '(counter (:start 3)) "#app")
```

ビルドは不要です。ページ内の `<script type="text/emacs-lisp">`（`src` 指定でもインラインでも可）を、Emacs が文書の順にバイトコンパイルして実行します。コンパイル結果は、そのソースか、それより前に読み込まれるファイル（そのマクロを使っているかもしれません）か、`react.el` が変わるまで、ブラウザに保存されます。そのため初回の訪問では閲覧者のブラウザでコンパイルします（速い機械で約0.5秒、遅い機械では数秒）。サイトは前もってコンパイルしておくこともできます: `node tools/compile.mjs -o compiled.json app.el ...`（同じ Emacs 30.2 を Node で動かします。隣に wasmacs のチェックアウトが要ります）と `<meta name="elisp-react:compiled" content="compiled.json">`。ソースが一致するファイルは、そのまま読み込まれます。

上の要素は、バッククォートで作ったただのデータです。`jsx` マクロを使うと、同じものをカンマなしで書けます。HTML タグか大文字で始まるコンポーネント名で始まるリストがマークアップで、それ以外はすべて Lisp として評価されます。

```elisp
(react-define-component 'Counter
  :initial-state (lambda (props) (list :count (or (plist-get props :start) 0)))
  :render
  (lambda (self)
    (jsx (div (:class "counter")
           (p (format "Count: %d" (react-state self :count)))
           (button (:on-click (lambda (_event)
                                (react-set-state self :count (1+ (react-state self :count)))))
             "+1")
           (when (> (react-state self :count) 9) (jsx (strong "a lot")))))))

(react-mount (jsx (Counter (:start 3))) "#app")
```

## 設定

自動で起動するページは、設定を `<meta>` 要素から読みます。手で起動するページ（`<html>` に `data-elisp-react-manual`）は `start()` に渡します。

```html
<html data-elisp-react-manual>
<script type="module">
  import { start } from "https://modeverv.github.io/elisp-react/js/elisp-react.js";
  window.elispReact = { ready: start({ timeout: 10000 }) };
</script>
```

| `start({...})` | `<meta name="...">` | |
|---|---|---|
| `wasmacs` | `elisp-react:wasmacs` | wasmacs の eval service が公開されている場所。 |
| `timeout` | `elisp-react:timeout` | イベントやページからの答えに Lisp が答えるまでに待つミリ秒（既定 30000。0 で無制限）。それより長くかかる Lisp（たとえば無限ループ）は中断できないので、Emacs を止め、ページはそれ以後何も送らず、シンボル `timeout` のエラーを報告します（`elisp-react:error` と赤い帯）。長い処理は途中でページに戻れます。`react-async` の中で数百件ごとに `(react-await (react-sleep 0))` を入れると、制限はその戻りごとに数え直されます。 |
| `bootTimeout` | `elisp-react:boot-timeout` | 起動にかけてよいミリ秒（既定 120000。0 で無制限）。止まった起動（終わらないダウンロード）は Emacs を止め、どこまで進んだかを添えて、シンボル `boot-timeout` で失敗します。`signal`（`AbortSignal`）で手で中断できます。 |
| `onProgress` | | `({ phase, url, bytes, from })`: 起動の進み具合です。`"build id"`、まだブラウザに無い Emacs のファイルごとの `"download"`、`"emacs"`、そしてページのファイルごとの `"lisp"`（`from` は前もってコンパイル済み、保存済み、その場でコンパイル）。同じものが `document` にイベント `elisp-react:progress` として届くので、「読み込み中…」の表示に使えます。 |
| `location` | | `"browser"` はページのアドレス。`"memory"` はホストが持つアドレスで、`/` から始まり、履歴も持ち、ハッシュのリンクもそこでたどります。既定は `"browser"` で、ページにアドレスが無いとき（elisp-studio のプレビュー、`about:srcdoc`）は `"memory"` です。 |
| `compiled` | `elisp-react:compiled` | `tools/compile.mjs` で作ったマニフェスト。ソースが一致するファイルは、ページの中でコンパイルしません。 |
| `cache` | `elisp-react:cache` | コンパイル結果を置く場所: `true` か `"local"`（`localStorage`、既定）、`"session"`（このタブだけ）、`false`（meta では `"none"`。起動のたびにコンパイルし、何も保存しません。開発用ツールの「再起動」）。 |
| `storage` | `elisp-react:storage` | `react-storage-set` がページの値を置く名前（既定はページのディレクトリ。`/app/` と `/app/index.html` は同じページです）。 |
| `library`、`sources`、`fetch` | | `react.el` の URL、ページのスクリプトの代わりに読み込む Lisp、`fetch` の代わりに使う関数（開発用ツール向け）。 |

`elisp-react.js` 自体が読み込めないと（ネットワークが無い、CDN が遮断されている）、エラーの帯も含めて何も動きません。そう知らせたいページは、数行を足せます。

```html
<script>
  setTimeout(() => { if (!window.elispReact) document.querySelector("#app").textContent = "このページのスクリプトを読み込めませんでした。"; }, 20000);
</script>
```

**時間の計測。** ホストは User Timing の計測を記録します。DevTools の Performance パネルに表示され、`PerformanceObserver` で集められます。`elisp-react:request` は Lisp への要求ごと（`detail` は何の要求か、返ってきた DOM 操作の数、往復の時間、適用の時間）、`elisp-react:lisp:FILE` は起動時に読み込んだファイルごと（`detail.from` は前もってコンパイル済み、保存済み、その場でコンパイル）、それに `elisp-react:start` です。

## 両側が Emacs

`examples/server/` は、独自の JavaScript もビルドもないアプリケーションです。ネイティブの Emacs プロセスが Web サーバーになってデータを持ち、ブラウザの中の Emacs がページを描画します。両者は JSON ではなく、印字した Lisp データをやり取りします。

```sh
examples/server/run.sh          # または M-x load-file server.el のあと M-x elisp-react-server-start
# 表示された URL を開きます: http://127.0.0.1:8017/examples/server/
```

```text
examples/server/server.el   サーバー。Emacs Lisp で書いた HTTP（make-network-process）、ファイル配信と小さな API
examples/server/app.el      ページ。react-fetch / react-async でサーバーに問い合わせるコンポーネント
examples/server/notes.el    両方が読み込む。リストを変更する関数と、メモの文字列の検査
```

このサンプルで分かること:

- **ビルドも、自前の JavaScript もありません。** 3つの `.el` ファイルがアプリケーションのすべてです。ブラウザが読み込み時にコンパイルし、結果を保存します。
- **言語もデータ形式も1つです。** 両側の間で JSON との変換をしません。片方で印字した plist は、もう片方で `read` すると同じ plist になります。
- **コードを共有できます。** `notes.el` は両側で動きます。サーバーはその関数でリストを変更し、ページはその検査でボタンを有効にし、サーバーは同じ検査で不正な入力を拒否します。
- **2つのタブが同期します。** ページは2秒ごとに問い合わせ直すので、別のタブや `curl` での変更が現れます。

リクエストの本文は `(add "text")` のようなアクションです。サーバーはそれをデータとして `read` し（送られてきたものを評価することはありません）、共有している関数で適用し、リストを `.eld` ファイルに保存して、新しいリストを返します。ページはそれを `read` して state に入れます。サーバーは 127.0.0.1 でだけ待ち受け、他サイトのページからのリクエストは拒否します。普段使っている Emacs の中で起動すれば、`/api/buffers` のように、その Emacs 自身の状態をページに見せることもできます。

保存したメモ、そのバックアップ、サンプルの `data/` ディレクトリ、隠しファイルは静的配信しません。symlink や大文字・小文字を変えた別名でも同じ制限が適用されます。アプリのファイルにも API と同じ Origin 検査を行い、別 Origin からの読み込みを許すのは、独立した `/wasmacs/` 配信先の公開ファイルだけです。

これはサンプルであり、アプリケーション用のサーバーではありません。ログイン、Cookie、セッション、アップロードはありません。リクエストの本文は 64 KB までで、1つの接続で扱うリクエストは1つです。接続数の制限もタイムアウトもなく、ファイルは全体をメモリに読み込んでから送ります。一方で、自分のマシンの外には開いていません。別の `Host` 名でのリクエストと、他サイトのページから `/api/` へのリクエストは拒否します。本文を読んでも、その中の名前は Emacs に残りません。リクエストのファイル名は、配信するディレクトリの下のファイルとしてしか扱いません（この3点は、[elisp-studio のセキュリティ検査](https://github.com/modeverv/elisp-studio/blob/main/doc/security.md)で見つかり、直したものです）。2回目の検査で、もう1点見つかりました。応答の途中で切断する訪問者がいると、サーバーが終了していました。バッチモードの Emacs は SIGPIPE で終了するためです。`run.sh` は、このシグナルを無視する設定で Emacs を起動するようになりました。サーバーは `run.sh` で起動してください。セッション、パスワードのハッシュ、アップロード、各種の制限を備え、手前にリバースプロキシを置けるサーバーは、[elisp-studio](https://github.com/modeverv/elisp-studio) のプロジェクトサーバーです。

## 構成

```text
lisp/react.el          React 本体: 要素、jsx、コンポーネント、state、key つきの差分計算、タイマー、fetch、保存、async/await（Emacs Lisp 910行）
js/elisp-react.js      土台: Emacs の起動、DOM 操作の適用、イベントの転送、依頼への応答、Lisp のコンパイルとキャッシュ（350行）
examples/counter/      state を持つコンポーネント
examples/counters/     親が state を持ち、props で渡し、イベントで戻す例。リストと入力欄つき
examples/todo/         TODO リスト。jsx、自分の state を持つ key つきの行、フィルタ、並べ替え、localStorage への保存
examples/async/        インターバル、タイムアウト、async/await で書いたカウントダウンと fetch
examples/server/       両側が Emacs。ネイティブの Emacs が Web サーバーになり、データを持つ
test/react-test.el     差分計算のテスト（ネイティブの Emacs で実行。ブラウザ不要）
test/e2e.mjs           サンプルを headless Chrome で動かすテスト
test/e2e-host.mjs      ホストが Lisp のためにすること（test/pages/）を headless Chrome で確かめるテスト
doc/design.md          仕組み（英語）
doc/experiment-notes.md  ここまでの実験で分かったこと
```

## API

要素はただの Lisp データです。`"text"`、`(TAG PROPS CHILD...)`、`(TAG CHILD...)` のいずれかで、`PROPS` は plist です。子の中の `nil` は無視され、要素のリスト（`mapcar` の結果）はその場に展開されます。

| | |
|---|---|
| `(react-define-component NAME :render F :initial-state F :did-mount F :did-update F :will-unmount F)` | コンポーネントを定義します。`:render` はインスタンスを受け取り、要素を1つ返します。`(NAME PROPS CHILD...)` という要素がこのコンポーネントになり、子は `:children` という prop で届きます。`:did-update` はインスタンス、前回の props、前回の state を受け取ります。 |
| `:did-catch (lambda (self error) ...)` | エラー境界です。下の部品が描画に失敗すると、その部品は何も描かず、この部品はふつう state を変えて別のものを表示します。境界が無ければ、エラーは `react-render-error` としてページに届き、その部品と上の部品の名前（`Card < Page < App`）を示します。描画を待っていたものは、次のイベントで描画されます。 |
| `(react-effect SELF KEY DEPS F)` | 描画の中で使います。前に実行したときから `DEPS`（`equal` で比べる任意のデータ）が変わっていれば、描画の後に `F` を実行します。`F` が関数を返すと、それが次の実行の前と、部品が外されるときの後始末になります。状態を持つ処理を、いくつもの部品が呼ぶ普通の関数にできます。`:did-mount`、`:did-update`、`:will-unmount` には関数のリストも渡せます。 |
| `(react-props SELF [KEY])`、`(react-state SELF [KEY])` | インスタンスの props / state（plist）、またはその中の1つの値。 |
| `(react-set-state SELF :key VALUE ...)` | 指定したキーを差し替えた新しい state を設定し、再描画します。「古い state を受け取って変更分を返す関数」を1つ渡すこともできます。1回のイベント中に何度呼んでも、描画は1回です。 |
| `(react-mount ELEMENT SELECTOR)` | CSS セレクタで指定したページ上の要素に描画します。 |
| `(jsx MARKUP)` | バッククォートなしで要素を作ります。HTML か SVG のタグで始まる `(TAG ...)` と、大文字で始まる名前の `(Component ...)` がマークアップです。`(svg ...)` の中の要素は SVG として作られます（インラインのグラフやアイコン）。prop の値、子、それ以外のものはすべて Lisp として評価されます。その Lisp の中でマークアップを書くときは、もう一度 `jsx` を使います。 |
| `(react-provide KEY VALUE CHILD)`、`(react-context SELF KEY [DEFAULT])` | `CHILD` より下のすべての部品に、間の props を通さずに、`KEY` で `VALUE` を渡します（言語、サインインしている人）。部品は `react-context` で読み、値が変わると描き直されます。その部品やその上の部品が `:pure` でも描き直されます。 |
| `(react-force-update SELF)`、`(react-refresh [TYPE])` | 1つのインスタンス、またはマウントされているすべて（部品 `TYPE` のものだけ）を、`:should-update` にかかわらず描き直します。props と state の外で読んでいるデータが変わったときに使います。 |
| `(react-render-to-string ELEMENT)` | `ELEMENT` を、ページ無しで HTML の文字列にします。クローラー、リンクのプレビュー、最初の表示を速くするための、サーバーが送る最初の画面です。native Emacs でも動きます。部品は最初の state で描かれ、描画の後の処理は動かず、何もマウントされたまま残りません。本文と属性はエスケープされます（その後ページがその上にマウントし直します。hydration はありません）。 |
| `(react-plist-with PLIST :key VALUE ...)` | 指定したキーを設定した新しい plist を返します。`PLIST` は変更しません。state の中のレコード用です。 |

Lisp はページに応答している間しか動きません。待つことも、ページの中に手を伸ばすこともできません。そこでコンポーネントはページに依頼を出し、結果が出たらページが Lisp の関数を呼びます。その関数はたいてい `react-set-state` で終わります。

| | |
|---|---|
| `(react-set-timeout MS F)`、`(react-set-interval MS F)`、`(react-clear-timer TIMER)` | あとで `F` を呼びます（1回、または繰り返し）。インターバルは `:did-mount` で始め、`:will-unmount` で止めます。 |
| `(react-fetch URL :method :headers :body :then F :catch F)`、`(react-response-json RESPONSE)`、`(react-cancel REQUEST)` | ブラウザの `fetch` です。`:then` は `(:status 200 :ok t :url "..." :redirected nil :headers (:content-type "..." ...) :text "...")` という plist を受け取ります（HTTP のエラーステータスのときも同じです）。応答そのものがなかったときは `:catch` がメッセージを受け取ります。`:body` の代わりに `:file (react-ref SELF NAME)` を渡すと、閲覧者がそのファイル入力で選んだファイルが本文になります。ファイルは、大きさにかかわらず、Lisp を通らずにページからサーバーへそのまま送られます。`:form (list 名前 値 ...)` は `multipart/form-data` で送ります。値は文字列か、ファイル入力の ref で、ref ならそこで選ばれたファイルを送ります。`:credentials`、`:cache`、`:redirect`、`:mode`、`:keepalive`、`:priority`、`:referrerPolicy` はそのまま `fetch` に渡ります。 |
| `(react-response-header RESPONSE NAME)`、`:as 'base64` と `(react-response-bytes RESPONSE)` | 応答のヘッダー（大文字小文字は問いません）。`:as 'base64` を付けると本文は `:text` ではなく `:base64` で届き、`react-response-bytes` がそれを unibyte の文字列にします。画像、アーカイブなど、どんなバイト列でも扱えます（付けないと本文は UTF-8 の文字列として読まれ、UTF-8 でないバイトは失われます）。 |
| `(react-listen-page TARGET EVENT F :keys KEYS :prevent t :throttle MS)` | `window` か `document` のイベント。どこで押されたキーでも、`resize`、`scroll`、`visibilitychange` も受け取れます。`F` は `(:type :key :width :height :x :y :visibility)` を受け取ります。`:keys` はそのキーだけを受け取り、`:prevent` はブラウザにそのキーの既定の動作をさせません（`/` のショートカット）。`:throttle` は `MS` ごとに多くても1回だけ送ります。`react-cancel` で外します。 |
| `(react-media-query QUERY F)`、`(react-observe-visible SELF "name" F :margin M :threshold T)` | `F` は、CSS のメディアクエリが合うかどうか（`"(prefers-color-scheme: dark)"`）を、すぐと、変わるたびに受け取ります。または、その `:ref` の要素が見えているかと、どれだけ見えているかを受け取ります（`IntersectionObserver`。一覧の最後での「もっと読む」）。`react-cancel` で止めます。 |
| `(react-locale [PART])`、`(react-intl ITEMS F [LOCALE])`、`(react-intl-async ITEMS)` | ページの Emacs は C ロケールで動きます（英語の名前、コードポイント順。`format-time-string` は UTC 以外のタイムゾーンを無視します）。`react-locale` は閲覧者の `(:languages :timeZone :offset)` で、起動時から分かっています。`react-intl` はブラウザの `Intl` に、数（`(:type number :value 1234567 :options (:notation "compact"))` は日本語なら「123万」）、日時、相対時間、複数形の種類、リストを書かせ、またはロケールに合わせて文字列を並べ替えさせます。`F` は後で文字列を受け取るので、state に入れておきます。 |
| `(react-location [PART])`、`(react-location-watch F)`、`(react-location-unwatch HANDLE)` | ページのアドレス `(:href :pathname :search :hash)`。起動時から分かっています。リンク、戻る・進む、`react-navigate` のあと、`F` が新しいアドレスを受け取ります。 |
| `(react-navigate URL [REPLACE])`、`(react-history-go DELTA)` | 履歴に新しい項目を加えます（`REPLACE` なら今の項目を変えます）。同じオリジンならページはそのままで、監視している関数が呼ばれます。別のオリジンなら読み込みます。`DELTA` が -1 なら「戻る」です。 |
| `(react-set-title TEXT)`、`(react-set-meta NAME CONTENT)` | 文書のタイトル。`<meta>`（`"description"`、または `"og:title"` などのプロパティ）。`nil` で消します。 |
| `(react-url-query SEARCH)` | クエリ文字列を alist にします。エスケープは UTF-8 として読みます: `(react-url-query (react-location :search))`。 |
| `(react-websocket URL :on-open F :on-message F :on-close F :on-error F)`、`(react-websocket-send CONNECTION TEXT)` | WebSocket（`ws:`、`wss:`、またはこのサイトのパス）。`:on-message` は届いたテキストのメッセージを1つずつ、`:on-close` はコードと理由を受け取ります。`react-cancel` で閉じます（`:will-unmount` で）。 |
| `(react-event-source URL :on-message F :events NAMES :on-open F :on-error F :on-close F)` | サーバー送信イベント。`:on-message` は `(:type "message" :data "..." :id ...)` を受け取り、`:events` に並べた名前付きのイベントも同じように受け取ります。切れてもブラウザがつなぎ直し、`:on-close` はブラウザがあきらめたことを表します。`react-cancel` で閉じます。 |
| `(react-storage-get KEY [DEFAULT])`、`(react-storage-set KEY VALUE)`、`(react-storage-remove KEY)` | ページの `localStorage` です。印字できる Lisp データなら何でも保存できます。読み出しは即座に返ります（起動時にホストが Lisp に写しを渡します）。`react-storage-set` は値を置き換えます。同じページの別のタブがその間に保存したものも置き換えます。 |
| `(react-storage-watch KEY F)`、`(react-storage-unwatch HANDLE)` | 同じページの別のタブが `KEY` を変えたとき、Lisp の写しは新しい値になり、`F` がそれを受け取ります（消されたときは nil）。タブ間でリストを共有するなら、書く前にマージするか、描き直します。 |
| 要素の `:ref "name"`、`(react-focus SELF "name")`、`(react-invoke SELF "name" METHOD ARGS...)` | コンポーネントが描画した要素の DOM ノードのメソッドを呼びます。その描画の DOM 変更のあとに実行されます（`:did-update` か `:did-mount` の中で使います）。呼べるのは `focus`、`blur`、`select`、`click`、`scrollIntoView`、`scrollTo`、`scrollBy`、`setSelectionRange`、`showModal`、`show`、`close`、`requestSubmit`、`reset`、`reportValidity`、`setCustomValidity`、`play`、`pause`、`load`、`requestFullscreen`、`showPicker` です。引数は JSON のデータです: `(react-invoke self "list" "scrollTo" '(:top 0))`。 |
| `(react-make-ref SELF "name")`、`(react-root SELECTOR)` | 部品が下の部品に渡し、下の部品が描く要素に付けてもらう ref です: `(input (:ref (react-props self :input-ref)))` で、その要素は親の ref `"name"` になります。`react-root` は `react-mount` が `SELECTOR` に描いた部品のインスタンスを返します（部品の外のコードのため）。 |
| `(react-set-property SELF "name" PROPERTY VALUE)`、`(react-measure SELF "name" F)` | 属性ではない DOM プロパティを設定します: `indeterminate`、`selectedIndex`、`open`、`muted`、`volume`、`currentTime`、`playbackRate`、`loop`、`scrollTop`、`scrollLeft`（マークアップを受け取るものはありません）。ノードを測ります: `F` は箱 `(:x :y :width :height)`、スクロール（`:scrollTop` から `:clientHeight`）、音声と動画なら `:currentTime :duration :paused` を受け取ります。 |

ホストにできないことも、ページ自身のスクリプトならでき、両者は話せます。

```html
<script>
  // Lisp が呼べるコマンド: (react-host-call "width" ID FUNCTION) と (react-host-tell "set-title" TEXT)。
  window.elispReactCommands = {
    width(id, { reply, node }) { reply(node(id).getBoundingClientRect().width); },
    "set-title"(text) { document.title = text; },
  };
  // スクリプトが呼ぶ Lisp の関数。Promise が解決したとき、ページはその変更を表示しています。
  document.addEventListener("elisp-react:ready", () => window.elispReact.send("my-app-resized", innerWidth));
</script>
```

| | |
|---|---|
| `window.elispReactCommands[NAME] = (ARGUMENT, { reply, fail, node }) => CANCEL` | ページのコマンド。`reply(VALUE)` で Lisp に答え（Lisp がリクエストを保っていれば何度でも）、`fail(MESSAGE)` で失敗を答えます。`node(ID)` は Lisp が `ID` で呼ぶ DOM ノードです。返した関数は `react-cancel` のときに呼ばれます。通知は `(ARGUMENT, { node })` を受け取ります。 |
| `(react-host-call NAME ARGUMENT FUNCTION [KEEP])`、`(react-host-tell NAME ARGUMENT)`、`(react-node-id (react-ref SELF "name"))` | そのコマンドを呼びます（`FUNCTION` は `OK` と値を受け取ります）。答えの要らないものは `react-host-tell` で伝えます。`react-node-id` は `node(ID)` に渡すノードの番号です。 |
| `window.elispReact.send(NAME, ...ARGS)` | Lisp の関数 `NAME` を `ARGS`（JSON のデータ）で呼び、変わったところを描きます。ページが更新されたときに解決します。 |

**オリジンは1つの信頼の単位です。** `localStorage`、そこに保存したコンパイル結果、Cache Storage の Emacs は、ページのオリジンのものです。同じオリジンのページなら、どれでも別のページの保存値（API キー、トークン）を読め、別のページが次に読み込むコードを書き換えられ、フレームで開いて操作することもできます。保存の名前と `cache: "session"` は、まっとうなアプリケーション同士を分けるもので、悪意のあるページからは守りません。秘密を持つアプリケーションには、信頼できないページの無い、自分だけのオリジンが要ります。`USER.github.io` のような共有のホストでは、すべてのリポジトリの Pages が1つのオリジンを共有し、利用者が開いたどんなプロジェクトでも動かす elisp-studio のページ内の studio も同じです。コンパイル結果のマニフェスト（`tools/compile.mjs`）は、オリジンの保存領域ではなくサイトから取得します。

ログインについて、ページ側で決まっていることは次のとおりです（2026-11-15 に、Chrome から elisp-studio のプロジェクトサーバーに対して、セッションの Cookie と Bearer トークンを1つのページで試しました）。

- **Cookie は何もしなくても届きます。** `react-fetch` は、ブラウザの `fetch` を既定の設定のまま使います。ページ自身のサーバーへのリクエストには、そのサーバーの Cookie が付き、応答で渡された Cookie も保存されます。`HttpOnly` のセッション Cookie は、Lisp からは見えません。別のオリジンへのリクエストには、`:credentials "include"` を付けない限り Cookie が付かず、相手のサーバーの CORS の設定に従います。
- **トークンはヘッダーで送ります。** `:headers (:authorization "Bearer …")` で送れます（たとえば JWT）。その場合、トークンはページが持っておく必要があります。コンポーネントの state に置くと、再読み込みで消えます。`react-storage-set` に置くと `localStorage` に残り、ページのすべてのスクリプトから読めます。安全なのは Cookie のほうです。
- **応答として届くのは、ステータスとヘッダーと本文です。** `react-response-header` でヘッダー（`Link`、`Retry-After`、`ETag`）を読めます。CORS がページに見せないヘッダーは、Lisp にも見えません。
- **検証はサーバーの仕事です。** ページの Emacs にある暗号の機能は `secure-hash` だけです（[wasmacs の doc/eval-service.md](https://github.com/modeverv/wasmacs/blob/master/doc/eval-service.md#hashes-random-bytes-sockets)）。トークンの中身を読むことはできます（`base64-decode-string`、`json-parse-string`）。しかし、ページの中で検証しても、閲覧者はそれを書き換えられます。

同じ非同期処理を、上から下へ順に書くこともできます。`react-async` は本体を最初の `react-await` まで実行してページに戻り、ページから答えが来たら続きを実行します（Emacs の `generator.el` の上に作ってあります）。

```elisp
(react-async
  (react-set-state self :status 'loading)
  (condition-case failure
      (let ((response (react-await (react-fetch-async "quotes.json"))))
        (react-await (react-sleep 300))
        (react-set-state self :status 'loaded :quotes (react-response-json response)))
    (react-async-error (react-set-state self :status 'failed :error (cadr failure)))))
```

| | |
|---|---|
| `(react-async BODY...)`、`(react-await AWAITABLE)` | ループや条件分岐の中でも await できます。処理が失敗すると、その await の位置で `react-async-error` が発生します。await のあとでは state が変わっている可能性があるので、読み直してください。`react-async` はタスクを返し、タスクも await できます（値は本体の値です）。`lambda`、`with-temp-buffer`、`save-excursion`、`mapcar` などの中の await は、本体をコンパイルするときにエラーになります（generator.el がその中まで書き換えないため）。await するループの中で作るクロージャには、自分の束縛が要ります: `(let ((item item)) (lambda () item))`。 |
| `(react-task-cancel TASK)` | タスクを止めます。待っているリクエストを取り消し、本体はそれ以上進まず、await している側には `react-async-error`（"cancelled"）が届きます。部品が外されるときにタスクを止めるには `react-effect` を使います: `(react-effect self 'load (react-props self :id) (lambda () (let ((task (react-async ...))) (lambda () (react-task-cancel task)))))`。 |
| `(react-all AWAITABLES)`、`(react-race AWAITABLES)` | いくつか（関数かタスク）をまとめて待つ await できるもの。すべての値を順に返し、1つでも失敗するとすぐ失敗します。または、最初の答えを返します。 |
| `(react-sleep MS)`、`(react-fetch-async URL OPTIONS...)`（`react-fetch` の引数から `:then` と `:catch` を除いたもの） | await できるものです。`(RESOLVE REJECT)` を受け取り、どちらかを1回呼ぶ関数なら何でも await できます。 |

いくつもの部品や、同じページへの何度もの訪問が読むデータは、キーごとに保ちます。

| | |
|---|---|
| `(react-query SELF KEY LOADER :stale-ms MS)` | 描画の中で使います。`KEY`（`equal` で比べる任意の Lisp データ）のデータを、`LOADER` で読み込みます。`LOADER` は await できるものを返す関数です（`(lambda () (react-fetch-async "/videos.json"))`）。返り値は `(:status STATUS :data DATA :error ERROR :fetching BOOL)` で、`STATUS` は `loading`、`success`、`error` のどれかです。同じキーを求める部品はリクエストとデータを共有します。戻ってきた部品はデータをすぐに表示し、`:stale-ms`（既定 0）より古いキーは裏で読み込み直します。データが届くと、`:pure` かどうかにかかわらず、部品は描き直されます。 |
| `(react-invalidate PREFIX)`、`(react-query-set KEY DATA)`、`(react-query-data KEY)` | `PREFIX` そのもの、またはリスト `PREFIX` で始まるリストのキーをすべて古いことにします。読み込み直し、途中の答えは捨てます。キーにデータを手で置きます（楽観的な更新）。部品を依存させずにキーを読みます。 |

既定では、親が再描画されると子も必ず再描画されます。コンポーネントはこれを断ることができます。

| | |
|---|---|
| `:should-update (lambda (self previous-props previous-state) ...)` | nil を返すと、そのコンポーネントとその下すべての描画を省きます。`self` はすでに新しい props と state を持っています。 |
| `:pure t` | props か state が変わったときだけ描画します。文字列と数値は値で、それ以外（レコード、リスト、関数）は同一のオブジェクトかどうかで比べます。 |
| `(react-changed-p NEW OLD :key ...)`、`(react-shallow-equal A B)` | `:should-update` 用です。2つの plist の指定したキーだけ、または全部を比べます。 |

**ダイアログとフォーカス**はプラットフォームのものを使います。`(react-invoke self "dialog" "showModal")` で開いた `<dialog>`、または Lisp を使わず `:command "show-modal" :commandfor "その-id"` を持つボタンで開いた `<dialog>` は、本物のモーダルです。後ろのページは操作できなくなり、フォーカスは `:autofocus` の欄に移って中に留まり、Esc で閉じると `:on-close` が Lisp に伝え、フォーカスは開いたボタンに戻ります。`:inert t` は、ダイアログ無しでページの一部を操作できなくします。経路が変わった後は、新しいページの見出しに `:tabindex "-1"` を付けて `react-focus` すると、スクリーンリーダーがそこから読み始めます。

```elisp
(button (:ref "opener" :on-click (lambda (_event) (react-invoke self "settings" "showModal"))) "Settings")
(dialog (:ref "settings" :on-close (lambda (_event) (react-set-state self :saved t)))
  (input (:autofocus t)) (button (:on-click (lambda (_event) (react-invoke self "settings" "close"))) "Done"))
```

カスタム要素は、ハイフンを含む大文字で始まる名前で書きます: `(X-widget (:size "2"))`。その名前の部品は無いので `<x-widget>` になります。ハイフンを含まない大文字で始まる名前で部品が無いものは、たいてい綴りの間違いか、使うファイルより後に読み込まれたファイルの部品です。未知の要素として描かれ、ページのコンソールに一度だけそう表示されます。計算した props（親から受け取ってそのまま渡すものなど）は、ふつうのリストの形で書きます。`jsx` の子にもできます: `(list 'button (append '(:class "primary") (react-props self :button-props)) "OK")`。

render 関数の中の `lambda` は描画のたびに新しいオブジェクトになりますが、`:pure` は、同じ `lambda` から作られ、取り込んだ値が同じ（一段だけ比べます）2つのクロージャを同じ関数とみなします。`(VideoCard (:on-pick (lambda (_event) (pick video))))` は、`video` が同じオブジェクトである限り描画を省きます。描画のたびに新しいもの（描画の中で作ったリストなど）を取り込むクロージャでは効かないので、その場合は `react-changed-p` でデータの prop だけを比べ、ハンドラの中では関数の prop をイベント時に読みます（`(funcall (react-props self :on-change) ...)`）。描画を省いたコンポーネントにも、新しい props は渡されています。

増減や並べ替えのあるリストの子には `:key` を付けます（`(li (:key id) ...)`）。前回と同じ key の子は同じ子として扱われ、リスト内の位置が変わっても、DOM ノードと、その中のコンポーネントの state を保ちます。動かすノードは最小限です。key のない子は位置で対応づけます。

DOM 要素の props: `:on-click`、`:on-input`、`:on-submit` などはイベントリスナーです（関数は `:type :value :checked :key :code :alt :ctrl :meta :shift :repeat :composing :button :x :y :target` を持つ plist を受け取ります。`:composing` は IME が変換中のとき t、`:target` はイベントが起きたノードの番号です。ファイル入力では、`(:name :size :type)` のベクタである `:files` も付きます。submit では、フォームの項目が `:form` に入り、`(react-form-value EVENT NAME)` と `react-form-values` で読めます）。`:value` と `:checked` は DOM プロパティなので、入力欄は controlled になります。`:style` は文字列か plist です。plist の数値は、単位の無いプロパティを除いてピクセルです（`(:width 120 :opacity 0.5)`）。`:class` はリストでもかまいません（`'("card" nil "active")` は `card active` になります）。`:aria-...` 属性の `t` と `:false` は `"true"` と `"false"` になります。`:inner-html` はよそから来た HTML の文字列（説明文、Markdown から作った HTML）で、ホストが掃除してから表示します。文章と表の要素の一覧にない要素は外し（文字は残します）、script・style・フレーム・フォーム・SVG は捨て、スクリプトの URL を含まない普通の属性だけを残します。この要素は自分の子を持てません。それ以外は属性になります（`nil` で削除、`t` で空の属性）。 ホストはインラインの `on*` 属性と `srcdoc` を省き、URL 属性のスクリプト URL を削除して描画を続けます。イベントには Lisp の `:on-...` コールバックを使ってください。ページ作者の Lisp と意図して作る script 要素は信頼するコードです（[DOM の境界](doc/design.md#operations)）。

Lisp がイベントに答えるのはブラウザが動いた後なので、リンクやキーを止めるには遅すぎます。ページがすべきことを前もって伝えるリスナーが `react-handler` です。

```elisp
(input (:on-keydown (react-handler #'search :keys '("Enter") :prevent t)))
(div (:class "backdrop" :on-click (react-handler #'close-dialog :self t)) ...)
```

`:keys`（そのキーだけ）、`:self`（子ではなく要素自身のイベントだけ）、`:prevent`（`preventDefault`）、`:stop`（`stopPropagation`。親のリスナーには届きません）、`:capture`、`:passive`、`:throttle MS`（`MS` ごとに多くても1回。最後のイベントは残ります）が使えます。

## アプリケーションをテストする

`lisp/react-testing.el` は Lisp のデータでできたページです。Lisp が返す操作をブラウザと同じように適用するので、アプリケーションのテストがブラウザ無しで、どの Emacs でも動きます。

```elisp
(require 'react-testing)
(ert-deftest counter-counts ()
  (react-testing-load "counter.el")                       ; または (react-testing-render '(Counter))
  (react-testing-click (react-testing-find :class "increment"))
  (should (equal (react-testing-text (react-testing-find :class "count")) "Apples: 4")))
```

| | |
|---|---|
| `react-testing-render`、`react-testing-load`、`react-testing-reset`、`react-testing-storage`、`react-testing-location` | 最初からやり直します。要素を描くか、自分でマウントするファイルを読み込みます。ページの保存値とアドレスを前もって入れておけます。 |
| `react-testing-find`、`react-testing-find-all`（`:tag :class :text :attribute`）、`react-testing-text`、`react-testing-attribute`、`react-testing-property`、`react-testing-html` | 要素を探して読みます。 |
| `react-testing-click`、`react-testing-input`、`react-testing-key`、`react-testing-submit`、`react-testing-dispatch` | 閲覧者のすることをします。イベントはブラウザと同じように親へ上がっていきます。 |
| `react-testing-answer-fetch STATUS TEXT`、`react-testing-answer COMMAND VALUE`、`react-testing-time-passes`、`react-testing-requests`、`react-testing-told` | Lisp が求めたことにページとして答えます。fetch に答え、タイマーを進め、待っているものと Lisp がページに伝えたことを見ます。 |

`test/react-testing-test.el` は、この方法でサンプルを3つテストしています。ネイティブの Emacs ではなく、ページと同じ Emacs 30.2 でテストを動かすには、wasmacs の `tools/scripts/ert.mjs` を使います。

## 動いているページを書き換える

ページに表示中のコンポーネントを定義し直すと、新しい定義に入れ替わり、各インスタンスは今の state のまま再描画されます。土台はこれを `window.elispReact.load(name, text)` として公開しています。変更したソースを、動いているページの中でコンパイルして評価します。ソースは読み込めたがその後の描画に失敗したときは、`renderError` も付けて解決します。新しい定義は入っています。描画がうまくいけば、エラーの帯は消えます。[elisp-studio](https://github.com/modeverv/elisp-studio) はこの上に作られています。ブラウザの中の Emacs でファイルを編集すると、隣で動いているアプリケーションが、保存のたびにリロードなしで変わります。

[![elisp-studio: Emacs で編集している間もストップウォッチは動き続ける](https://raw.githubusercontent.com/modeverv/elisp-studio/main/doc/images/demo.gif)](https://github.com/modeverv/elisp-studio)

## 開発

```sh
npm run serve        # http://localhost:5180/examples/counter/
npm run test:lisp    # 差分計算のテスト（ネイティブの Emacs）
npm run test:e2e     # サンプルを headless Chrome で実行
npm run test:e2e-host  # ホストの機能（test/pages/）を headless Chrome で実行
npm run test:server  # サーバーのサンプル（Emacs のサーバープロセスと Chrome）
```

このリポジトリの**整形と lint。** `react.el` を読み込んだ Emacs は、部品とマークアップを例と同じ形に字下げします（`indent-region`）。`react-define-component` とすべてのタグは、props を特別な引数として扱います。lint としては、`test/run-ert.sh` が `react.el` にしているように、警告をエラーにしてアプリケーションのファイルをバイトコンパイルします（`--eval '(setq byte-compile-error-on-warn t)'`）。`tools/compile.mjs` は、ページのファイルについてのコンパイラの警告を、ページと同じ Emacs で表示します。

隣に wasmacs のチェックアウト（`../wasmacs/docs`）があれば、開発サーバーとブラウザテストはそこから Emacs を読み込みます。なければ wasmacs の公開サイトから読み込みます。

## 制限

これは実験で、フレームワークではありません。戻ってこないハンドラは中断できません（[timeout](#設定) を過ぎると Emacs を止め、ページがそう知らせます）。`async` の本体は途中でキャンセルできません。Emacs は初回に約5MBをダウンロードします（Emacs 本体です。付属の Lisp ファイル 146MB からは、ページが読んだものだけを取得します。あとから `require` したライブラリは、そのときに取得します）。key つきの1000行の再描画には約130ミリ秒、行を `:pure` にすると約30ミリ秒かかります。Emacs はタブごとにメモリを使います。起動時に線形メモリを 1GiB 確保し（最大 2GiB）、[Parens](https://github.com/modeverv/elisp-react-youtube-similar) のようなページはデスクトップの Chrome でレンダラーのメモリが 265〜335MB でした。Emacs を除いて保存した同じページは 136MB です。実機のスマートフォンではまだ試していません（[wasmacs#12](https://github.com/modeverv/wasmacs/issues/12)）。`examples/server/` のサーバーはサンプルの一部で、公開するためのものではありません（足りないものは「両側が Emacs」にあります）。詳しくは [doc/experiment-notes.md](doc/experiment-notes.md) を参照してください。

## ライセンス

MIT ライセンスです（[LICENSE](LICENSE)）。ライセンスの表示を残せば、自由に使えます。`examples/` の下のサンプルは出発点として使うためのもので、条件は何もありません（[0BSD](examples/LICENSE)）。表示なしで、自分のアプリケーションに取り込めます。

`react.el` は Emacs Lisp で、GNU Emacs の中で動きます。Emacs は GNU GPL（バージョン3以降）です。GPL は、[GPL のプログラムと結合されるコード](https://www.gnu.org/licenses/gpl-faq.html#GPLAndPlugins)に、GPL と両立するライセンスを求めます。MIT はその1つです（FSF の一覧では [Expat ライセンス](https://www.gnu.org/licenses/license-list.html#Expat)という名前です）。

- **このリポジトリに Emacs は含まれていません。** ページが [wasmacs](https://github.com/modeverv/wasmacs) のサイトからダウンロードします。そのビルドのライセンスとソースの場所は、wasmacs の [NOTICE.md](https://github.com/modeverv/wasmacs/blob/master/NOTICE.md) にあります。
- **その Emacs を自分のサイトにコピーして置く場合**は、GPL のもとで Emacs を配布することになります。wasmacs の `licenses/` ディレクトリを、コピーと一緒に置いてください。
- **自分で書いた `.el` ファイル**も Emacs の中で動き、Emacs の Lisp ライブラリを使います。FSF の解釈では、[そうしたライブラリを使うプログラム](https://www.gnu.org/licenses/gpl-faq.html#IfInterpreterIsGPL)を公開するときは、GPL と両立するライセンスにする必要があります。ページの `app.el` はすべての閲覧者に送られるので、公開にあたります。MIT、0BSD、GPL そのもののいずれでも条件を満たします。

elisp-react は Meta の React とは無関係で、そのコードを含みません。
