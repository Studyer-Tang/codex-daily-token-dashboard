using System.Collections.Generic;

internal sealed partial class TokenWidgetForm
{
    private sealed class UsageTask
    {
        public string Id = "";
        public string Revision = "";
        public bool FollowLatest;
        public string FocusTimestamp = "";
        public string Label = "匿名任务";
        public string Title = "";
        public string LastActivity = "";
        public double TotalTokens;
        public double InputTokens;
        public double CachedInputTokens;
        public double OutputTokens;
        public int TurnCount;
        public bool DetailsLoaded;
        public bool DetailsLoading;
        public string DetailError = "";
        public List<UsageTurn> Turns = new List<UsageTurn>();

        public bool UpdateRevision(string next)
        {
            if (Revision == next) return false;
            Revision = next;
            DetailsLoaded = false;
            DetailError = "";
            Turns.Clear();
            return true;
        }
    }

    private sealed class UsageTurn
    {
        public int Number;
        public string Timestamp = "";
        public bool Identified;
        public string Prompt = "";
        public double TotalTokens;
        public double InputTokens;
        public double CachedInputTokens;
        public double OutputTokens;
    }
}
