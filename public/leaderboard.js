(() => {
  // Read the viewer's own name from URL param ?name=
  const params = new URLSearchParams(window.location.search);
  const myName = (params.get('name') || '').trim().toLowerCase();

  const MEDALS = ['🥇', '🥈', '🥉'];

  const socket = io({ transports: ['websocket'] });

  socket.on('connect', () => {
    socket.emit('joinLeaderboard');
  });

  socket.on('leaderboardUpdate', (rows) => {
    const tbody = document.getElementById('lbBody');
    if (!rows || rows.length === 0) {
      tbody.innerHTML = `<tr><td colspan="5">
        <div class="empty-state">
          <div class="empty-icon">🏆</div>
          No players yet — be the first!
        </div></td></tr>`;
      return;
    }

    const html = rows.map((row, i) => {
      const rank = i + 1;
      const rankCell = rank <= 3
        ? `<span class="rank-badge">${MEDALS[rank - 1]}</span>`
        : `<span style="color:#555">${rank}</span>`;

      const isMe = myName && row.name.toLowerCase() === myName;
      const nameTag = isMe ? `<span class="name-me-tag">YOU</span>` : '';
      const trClass = isMe ? ' class="highlight-me"' : '';

      return `<tr${trClass}>
        <td class="rank-cell">${rankCell}</td>
        <td class="name-cell">${escHtml(row.name)}${nameTag}</td>
        <td class="elo-cell right">${row.elo}</td>
        <td class="wins-cell right">${row.wins}</td>
        <td class="games-cell right">${row.games}</td>
      </tr>`;
    }).join('');

    tbody.innerHTML = html;
  });

  function escHtml(str) {
    return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }
})();
