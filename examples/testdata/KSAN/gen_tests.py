from pathlib import Path
import random


ROOT = Path(__file__).resolve().parent


def rooms_needed(arrivals, durations):
    events = []
    for t, d in zip(arrivals, durations):
        events.append((t, 1))
        events.append((t + d, -1))
    events.sort(key=lambda item: (item[0], item[1]))
    current = 0
    best = 0
    for _, delta in events:
        current += delta
        if current > best:
            best = current
    return best


def write_case(index, arrivals, durations):
    n = len(arrivals)
    input_text = f"{n}\n" + " ".join(map(str, arrivals)) + "\n" + " ".join(map(str, durations)) + "\n"
    output_text = f"{rooms_needed(arrivals, durations)}\n"
    (ROOT / f"ksan{index:02d}.in").write_text(input_text, encoding="ascii")
    (ROOT / f"ksan{index:02d}.out").write_text(output_text, encoding="ascii")


def random_case(rng, n, t_limit, d_limit):
    arrivals = [rng.randint(1, t_limit) for _ in range(n)]
    durations = [rng.randint(1, d_limit) for _ in range(n)]
    return arrivals, durations


def linear_window_case(n, duration):
    arrivals = list(range(1, n + 1))
    durations = [duration] * n
    return arrivals, durations


def same_start_case(n, start, duration_seed):
    arrivals = [start] * n
    durations = [(i % duration_seed) + 1 for i in range(n)]
    return arrivals, durations


def grouped_case(groups, group_size, gap, duration):
    arrivals = []
    durations = []
    for g in range(groups):
        base = 1 + g * gap
        for i in range(group_size):
            arrivals.append(base)
            durations.append(duration + i % 3)
    return arrivals, durations


def main():
    rng = random.Random(20260406)
    cases = []

    cases.append(([1, 2, 3], [3, 3, 3]))
    cases.append(([1, 2, 3, 4, 5], [2, 3, 4, 5, 6]))
    cases.append(([10], [5]))
    cases.append(([1, 2, 3, 4, 5], [1, 1, 1, 1, 1]))
    cases.append(([7, 7, 7, 7, 7, 7], [1, 2, 3, 4, 5, 6]))
    cases.append(([1, 2, 3, 4, 5, 6], [10, 10, 10, 10, 10, 10]))
    cases.append(([5, 1, 3, 6, 2], [2, 4, 1, 1, 3]))
    cases.append(([1, 2, 3, 4], [4, 3, 2, 1]))
    cases.append(([2, 4, 4, 7, 8, 8, 10], [3, 1, 4, 2, 1, 5, 2]))
    cases.append(([1, 1, 2, 2, 3, 3, 4, 4], [2, 3, 2, 3, 2, 3, 2, 3]))
    cases.append(([1000000000 - 10, 1000000000 - 9, 1000000000 - 8, 1000000000 - 2], [1, 2, 3, 2]))
    cases.append(([9, 1, 8, 2, 7, 3, 6, 4, 5], [5, 1, 4, 2, 3, 2, 4, 1, 5]))
    cases.append(grouped_case(groups=5, group_size=4, gap=3, duration=5))
    cases.append(linear_window_case(30, 7))
    cases.append(same_start_case(50, 12345, 20))
    cases.append(linear_window_case(50, 2))
    cases.append(random_case(rng, 100, 500, 50))
    cases.append(random_case(rng, 200, 1000, 200))
    cases.append(random_case(rng, 1000, 10000, 1000))
    cases.append(random_case(rng, 5000, 100000, 5000))
    cases.append(linear_window_case(100000, 1))
    cases.append(same_start_case(100000, 42, 1000))
    cases.append(linear_window_case(100000, 500))
    cases.append(grouped_case(groups=20000, group_size=3, gap=2, duration=4))
    arrivals = [1000000000 - 200000 + i * 2 for i in range(50000)]
    durations = [(i % 700) + 1 for i in range(50000)]
    cases.append((arrivals, durations))

    assert len(cases) == 25
    for idx, (arrivals, durations) in enumerate(cases, start=1):
        write_case(idx, arrivals, durations)


if __name__ == "__main__":
    main()
