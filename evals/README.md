# チャットの評価

質問ごとに、期待したツールが呼ばれるかを測ります（[docs/plan.md](../docs/plan.md) の P4 の出口条件）。質問と期待は [chat_tool_cases.json](chat_tool_cases.json)、実行するのは [run_chat_tools.py](run_chat_tools.py) です。

- 判定するのは、呼んだツールの名前（1 回だけ）と、結果の絞り込み（範囲・分類）か断りの理由です。**返答の本文の良し悪しは測りません。**
- 地区の名前は実データ（パリ南西の近郊の 12 地区）のものです。名前は解析結果を読み込むと決まるので、地区を取り直したら質問も直します。実データを読み込んだ手元の API に送ります。
- ログインせずに送るので、会話は保存されません。

## 実行

```bash
python3 evals/run_chat_tools.py              # 何も送らず、件数だけを出す
python3 evals/run_chat_tools.py --run --real # 実 Gemini に送る（実 API。先に件数と回数を示して承認を得る）
```

実 Gemini では、1 問につき約 2 回の呼び出しになります（再試行があれば増えます）。間隔は 7 秒です。返答の本文を読むときは `--show-replies` を付けます。

評価の道具そのものの確認には、模擬モデルを使います（Claude Code の内部の検証だけ）。模擬モデルの結果は、実 Gemini の成績ではありません。

```bash
scripts/with-mock-llm.sh python3 evals/run_chat_tools.py --run
```

秘密を Infisical に置いているときは、`TOWNSCAN_INFISICAL_PROJECT_ID` を設定して流します。
