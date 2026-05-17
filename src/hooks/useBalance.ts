export function useBalance() {
  return {
    formatEth(wei: bigint | null): string {
      if (wei === null) return '—';
      const eth = Number(wei) / 1e18;
      if (eth === 0) return '0';
      if (eth < 0.0001) return '<0.0001';
      return eth.toFixed(4);
    },
    formatSol(lamports: bigint | null): string {
      if (lamports === null) return '—';
      const sol = Number(lamports) / 1e9;
      if (sol === 0) return '0';
      if (sol < 0.001) return '<0.001';
      return sol.toFixed(4);
    },
    shortenAddress(addr: string, chars = 6): string {
      if (!addr) return '';
      if (addr.length <= chars * 2 + 3) return addr;
      return `${addr.slice(0, chars + 2)}...${addr.slice(-chars)}`;
    },
  };
}
