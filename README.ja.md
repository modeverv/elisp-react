# elisp-react

Emacs Lisp で書いた React です。

これは実験です。2013年ごろの React（props と state を持つコンポーネント、仮想 DOM を返す render 関数、差分計算）を Emacs Lisp で書いて、本物の Web ページを動かせるかを確かめます。GNU Emacs 30.2 がページの中で WebAssembly として動きます（[wasmacs](https://github.com/modeverv/wasmacs)）。コンポーネント、state、差分計算はすべて Emacs Lisp で、JavaScript は Lisp が計算した DOM 操作を適用するだけです。

公開ページ: <https://modeverv.github.io/elisp-react/> （サンプルを最初に開くとき、Emacs 本体を約150MBダウンロードします）

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

ビルドは不要です。ページ内の `<script type="text/emacs-lisp">`（`src` 指定でもインラインでも可）を、Emacs が文書の順に評価します。

## 構成

```text
lisp/react.el          React 本体: 要素、コンポーネント、state、差分計算（Emacs Lisp 450行）
js/elisp-react.js      土台: Emacs の起動、DOM 操作の適用、イベントの転送（210行）
examples/counter/      state を持つコンポーネント
examples/counters/     親が state を持ち、props で渡し、イベントで戻す例。リストと入力欄つき
test/react-test.el     差分計算のテスト（ネイティブの Emacs で実行。ブラウザ不要）
test/e2e.mjs           サンプルを headless Chrome で動かすテスト
doc/design.md          仕組み（英語）
doc/experiment-notes.md  ここまでの実験で分かったこと
```

## API

要素はただの Lisp データです。`"text"`、`(TAG PROPS CHILD...)`、`(TAG CHILD...)` のいずれかで、`PROPS` は plist です。子の中の `nil` は無視され、要素のリスト（`mapcar` の結果）はその場に展開されます。

| | |
|---|---|
| `(react-define-component NAME :render F :initial-state F :did-mount F :will-unmount F)` | コンポーネントを定義します。`:render` はインスタンスを受け取り、要素を1つ返します。`(NAME PROPS CHILD...)` という要素がこのコンポーネントになり、子は `:children` という prop で届きます。 |
| `(react-props SELF [KEY])`、`(react-state SELF [KEY])` | インスタンスの props / state（plist）、またはその中の1つの値。 |
| `(react-set-state SELF :key VALUE ...)` | 指定したキーを差し替えた新しい state を設定し、再描画します。「古い state を受け取って変更分を返す関数」を1つ渡すこともできます。1回のイベント中に何度呼んでも、描画は1回です。 |
| `(react-mount ELEMENT SELECTOR)` | CSS セレクタで指定したページ上の要素に描画します。 |

DOM 要素の props: `:on-click`、`:on-input`、`:on-submit` などはイベントリスナーです（関数は `:type :value :checked :key` を持つ plist を受け取ります）。`:value` と `:checked` は DOM プロパティなので、入力欄は controlled になります。`:style` は文字列か plist です。それ以外は属性になります（`nil` で削除、`t` で空の属性）。

## 開発

```sh
npm run serve        # http://localhost:5180/examples/counter/
npm run test:lisp    # 差分計算のテスト（ネイティブの Emacs）
npm run test:e2e     # サンプルを headless Chrome で実行
```

このリポジトリの隣に wasmacs のチェックアウト（`../wasmacs/docs`）があれば、開発サーバーとブラウザテストはそこから Emacs を読み込みます。なければ wasmacs の公開サイトから読み込みます。

## 制限

これは実験の第1段階で、フレームワークではありません。子要素は位置で対応づけます（key による並べ替えは未対応）。非同期処理（エフェクトやデータ取得）はありません。戻ってこないハンドラは中断できません。Emacs は約150MBのダウンロードです。詳しくは [doc/experiment-notes.md](doc/experiment-notes.md) を参照してください。
