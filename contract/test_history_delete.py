"""会話の削除 `DELETE /api/conversations/{conversation_id}`（構成 history。H-D1〜H-D3。仕様 §2.3.7・§4.4・§8 の E9）。

本人の削除は物理削除（印を付けるだけではない）。204・本文なし。無い・他人は 404（本文も同じ）。同じ ID で話しかけ直しても、前の発言は戻らない。
"""

from __future__ import annotations

import pytest

from support.history import (
    QUESTION,
    assert_not_found,
    new_id,
    user_message,
)

pytestmark = [pytest.mark.history, pytest.mark.variant("history")]


# ---- H-D1 ----

def test_h_d1_the_owner_can_delete_a_conversation(api, jwks, member):
    user = member()
    keep, gone = new_id(), new_id()
    user.say(QUESTION, keep)
    user.say("上位2件の一覧", gone)
    resp = user.delete(gone)
    assert resp.status == 204 and resp.body == b"", resp  # 本文なし
    assert user.listed_ids() == [keep]  # 一覧から消える
    assert_not_found(user.messages(gone))  # 発言の取得は 404
    assert_not_found(user.delete(gone))  # 二度目は 404
    assert len(user.stored(keep)) == 2  # ほかの会話は残る


# ---- H-D2 ----

def test_h_d2_another_user_cannot_delete_it(api, jwks, member):
    a, b = member(), member()
    cid = new_id()
    a.say(QUESTION, cid)
    before = (a.listed(), a.stored(cid))
    unknown = b.delete(new_id())
    other = b.delete(cid)
    assert_not_found(other)
    assert other.body == unknown.body  # 存在しない ID と同じ 404（本文も）
    assert (a.listed(), a.stored(cid)) == before  # A の会話は残り、発言も変わらない


# ---- H-D3 ----

def test_h_d3_a_deleted_conversation_is_really_gone_and_the_same_id_starts_a_new_one(api, jwks, member):
    user = member()
    cid = new_id()
    user.say("合成町の新規出現は何件？", cid)
    user.say("では試験町は？", cid)
    assert len(user.stored(cid)) == 4
    assert user.delete(cid).status == 204
    user.say(QUESTION, cid)  # 同じ ID で話しかける
    stored = user.stored(cid)
    assert len(stored) == 2, stored  # 古い発言は戻らない
    assert stored[0] == user_message(QUESTION)
    assert user.listed_ids() == [cid]
