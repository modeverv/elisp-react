# elisp-react

Emacs Lisp で書いた React です。

これは実験です。2013年ごろの React（props と state を持つコンポーネント、仮想 DOM を返す render 関数、差分計算）を Emacs Lisp で書いて、本物の Web ページを動かせるかを確かめます。GNU Emacs 30.2 がページの中で WebAssembly として動きます（[wasmacs](https://github.com/modeverv/wasmacs)）。コンポーネント、state、差分計算はすべて Emacs Lisp で、JavaScript は Lisp が計算した DOM 操作を適用するだけです。

公開ページ: <https://modeverv.github.io/elisp-react/> （サンプルを最初に開くとき、Emacs 本体を約150MBダウンロードします。以後はブラウザに保存され、2回目からは約0.2秒で描画されます）

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

ビルドは不要です。ページ内の `<script type="text/emacs-lisp">`（`src` 指定でもインラインでも可）を、Emacs が文書の順にバイトコンパイルして実行します。コンパイル結果は、ソースが変わるまでブラウザに保存されます。

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
doc/design.md          仕組み（英語）
doc/experiment-notes.md  ここまでの実験で分かったこと
```

## API

要素はただの Lisp データです。`"text"`、`(TAG PROPS CHILD...)`、`(TAG CHILD...)` のいずれかで、`PROPS` は plist です。子の中の `nil` は無視され、要素のリスト（`mapcar` の結果）はその場に展開されます。

| | |
|---|---|
| `(react-define-component NAME :render F :initial-state F :did-mount F :did-update F :will-unmount F)` | コンポーネントを定義します。`:render` はインスタンスを受け取り、要素を1つ返します。`(NAME PROPS CHILD...)` という要素がこのコンポーネントになり、子は `:children` という prop で届きます。`:did-update` はインスタンス、前回の props、前回の state を受け取ります。 |
| `(react-props SELF [KEY])`、`(react-state SELF [KEY])` | インスタンスの props / state（plist）、またはその中の1つの値。 |
| `(react-set-state SELF :key VALUE ...)` | 指定したキーを差し替えた新しい state を設定し、再描画します。「古い state を受け取って変更分を返す関数」を1つ渡すこともできます。1回のイベント中に何度呼んでも、描画は1回です。 |
| `(react-mount ELEMENT SELECTOR)` | CSS セレクタで指定したページ上の要素に描画します。 |
| `(jsx MARKUP)` | バッククォートなしで要素を作ります。HTML タグで始まる `(TAG ...)` と、大文字で始まる名前の `(Component ...)` がマークアップです。prop の値、子、それ以外のものはすべて Lisp として評価されます。その Lisp の中でマークアップを書くときは、もう一度 `jsx` を使います。 |
| `(react-plist-with PLIST :key VALUE ...)` | 指定したキーを設定した新しい plist を返します。`PLIST` は変更しません。state の中のレコード用です。 |

Lisp はページに応答している間しか動きません。待つことも、ページの中に手を伸ばすこともできません。そこでコンポーネントはページに依頼を出し、結果が出たらページが Lisp の関数を呼びます。その関数はたいてい `react-set-state` で終わります。

| | |
|---|---|
| `(react-set-timeout MS F)`、`(react-set-interval MS F)`、`(react-clear-timer TIMER)` | あとで `F` を呼びます（1回、または繰り返し）。インターバルは `:did-mount` で始め、`:will-unmount` で止めます。 |
| `(react-fetch URL :method :headers :body :then F :catch F)`、`(react-response-json RESPONSE)`、`(react-cancel REQUEST)` | ブラウザの `fetch` です。`:then` は `(:status 200 :ok t :text "...")` という plist を受け取ります（HTTP のエラーステータスのときも同じです）。応答そのものがなかったときは `:catch` がメッセージを受け取ります。 |
| `(react-storage-get KEY [DEFAULT])`、`(react-storage-set KEY VALUE)`、`(react-storage-remove KEY)` | ページの `localStorage` です。印字できる Lisp データなら何でも保存できます。読み出しは即座に返ります。 |
| 要素の `:ref "name"`、`(react-focus SELF "name")`、`(react-invoke SELF "name" METHOD)` | コンポーネントが描画した要素の DOM ノードに対して `focus`、`blur`、`select`、`click`、`scrollIntoView` を呼びます。その描画の DOM 変更のあとに実行されます（`:did-update` か `:did-mount` の中で使います）。 |

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
| `(react-async BODY...)`、`(react-await AWAITABLE)` | ループや条件分岐の中でも await できます。処理が失敗すると、その await の位置で `react-async-error` が発生します。await のあとでは state が変わっている可能性があるので、読み直してください。 |
| `(react-sleep MS)`、`(react-fetch-async URL :method :headers :body)` | await できるものです。`(RESOLVE REJECT)` を受け取り、どちらかを1回呼ぶ関数なら何でも await できます。 |

既定では、親が再描画されると子も必ず再描画されます。コンポーネントはこれを断ることができます。

| | |
|---|---|
| `:should-update (lambda (self previous-props previous-state) ...)` | nil を返すと、そのコンポーネントとその下すべての描画を省きます。`self` はすでに新しい props と state を持っています。 |
| `:pure t` | props か state が変わったときだけ描画します。文字列と数値は値で、それ以外（レコード、リスト、関数）は同一のオブジェクトかどうかで比べます。 |
| `(react-changed-p NEW OLD :key ...)`、`(react-shallow-equal A B)` | `:should-update` 用です。2つの plist の指定したキーだけ、または全部を比べます。 |

render 関数の中の `lambda` は描画のたびに新しいオブジェクトになるので、関数の prop があると `:pure` は効きません。その場合は `react-changed-p` でデータの prop だけを比べ、ハンドラの中では関数の prop をイベント時に読みます（`(funcall (react-props self :on-change) ...)`）。描画を省いたコンポーネントにも、新しい props は渡されています。

増減や並べ替えのあるリストの子には `:key` を付けます（`(li (:key id) ...)`）。前回と同じ key の子は同じ子として扱われ、リスト内の位置が変わっても、DOM ノードと、その中のコンポーネントの state を保ちます。動かすノードは最小限です。key のない子は位置で対応づけます。

DOM 要素の props: `:on-click`、`:on-input`、`:on-submit` などはイベントリスナーです（関数は `:type :value :checked :key` を持つ plist を受け取ります）。`:value` と `:checked` は DOM プロパティなので、入力欄は controlled になります。`:style` は文字列か plist です。それ以外は属性になります（`nil` で削除、`t` で空の属性）。

## 動いているページを書き換える

ページに表示中のコンポーネントを定義し直すと、新しい定義に入れ替わり、各インスタンスは今の state のまま再描画されます。土台はこれを `window.elispReact.load(name, text)` として公開しています。変更したソースを、動いているページの中でコンパイルして評価します。[elisp-studio](https://github.com/modeverv/elisp-studio) はこの上に作られています。ブラウザの中の Emacs でファイルを編集すると、隣で動いているアプリケーションが、保存のたびにリロードなしで変わります。

[![elisp-studio: Emacs で編集している間もストップウォッチは動き続ける](https://raw.githubusercontent.com/modeverv/elisp-studio/main/doc/images/demo.gif)](https://github.com/modeverv/elisp-studio)

## 開発

```sh
npm run serve        # http://localhost:5180/examples/counter/
npm run test:lisp    # 差分計算のテスト（ネイティブの Emacs）
npm run test:e2e     # サンプルを headless Chrome で実行
npm run test:server  # サーバーのサンプル（Emacs のサーバープロセスと Chrome）
```

このリポジトリの隣に wasmacs のチェックアウト（`../wasmacs/docs`）があれば、開発サーバーとブラウザテストはそこから Emacs を読み込みます。なければ wasmacs の公開サイトから読み込みます。

## 制限

これは実験で、フレームワークではありません。戻ってこないハンドラは中断できません。`async` の本体は途中でキャンセルできません。Emacs は初回に約150MBをダウンロードします。key つきの1000行の再描画には約130ミリ秒、行を `:pure` にすると約30ミリ秒かかります。詳しくは [doc/experiment-notes.md](doc/experiment-notes.md) を参照してください。
