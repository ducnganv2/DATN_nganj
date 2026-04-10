#include <bits/stdc++.h>
using namespace std;

#define ii pair<int, int>

bool cmp(ii a, ii b) {
    if (a.first == b.first) return a.second < b.second;
    return a.first < b.first;
}

int main() {
    ios_base::sync_with_stdio(false);
    cin.tie(nullptr);

    int n;
    cin >> n;
    vector<int> a(n);
    for (int i = 0; i < n; i++) cin >> a[i];

    vector<ii> v;
    v.reserve(2 * n);
    for (int i = 0; i < n; i++) {
        int x;
        cin >> x;
        x += a[i];
        v.push_back({a[i], 1});
        v.push_back({x, -1});
    }

    sort(v.begin(), v.end(), cmp);

    long long sum = 0;
    long long ans = 0;
    for (ii x : v) {
        if (x.second == 1) sum++;
        else sum--;
        ans = max(ans, sum);
    }

    cout << ans;
    return 0;
}
